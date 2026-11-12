/*
 * audfprint match fan-out: the database shards (.pklz) are spread round-robin
 * over --threads worker processes, and each worker has its shards matched one at
 * a time by a Python matcher it keeps running (libs/audfprint/match_server.py,
 * the same code as `audfprint.py match`).
 *
 * A shard that cannot be matched - a corrupt or truncated .pklz, a MemoryError,
 * a shard deleted mid-run - is reported and skipped; it never takes the run
 * down with it. Previously a failed match rejected inside the worker, the
 * rejection went unhandled, the worker died with the rest of its chunk, and the
 * primary waited forever for shards that would never report. On 2026-09-23 four
 * corrupt shards hung two whole runs that way.
 *
 * Kept deliberately unchanged, because anything that watches a run from outside
 * (a front end, a progress script) can infer progress from them:
 *   - scheduling is round-robin: shard i goes to worker i % threads, in order;
 *   - a shard being matched has a temp/<shard>.match.txt, created before its
 *     match starts and deleted once its results are folded in (the 2nd, 3rd ...
 *     shard with the same file name uses temp/<shard>~2.match.txt, ~3 ...; see
 *     assignMatchFiles);
 *   - each finished shard prints "(n/total) Analysis completed for: <shard>".
 *
 * Output: temp/_results.json (all matches) and temp/_failed_pklzs.txt (one
 * "<path>\t<reason>" line per shard that could not be matched), plus
 * temp/_checkpoint.json: the shards finished so far and their results, written
 * between shards about once a minute, so werzatsong.js --resume can carry on
 * after a crash or cancel (--resume-from <checkpoint> starts from one; the
 * shard list then holds only the shards still to do).
 *
 * Load speed (2026-11-11): checksums are verified once.
 * Every .pklz is a gzip file, and verifying its CRC32 costs about a quarter
 * of loading it. The matcher reports each file whose checksum it verified
 * (size and modification time, read from the open file), the primary keeps
 * them in cache/pklz-verified.json, and on later searches sends that back
 * with the file: if the file still has that size and time, the matcher skips
 * the CRC32 (libs/audfprint/hash_table.py, _read_pklz; the deflate data and
 * every length are still checked). A file is verified again when it changes
 * and anyway every CHECKSUM_REVERIFY_DAYS days, give or take half, so not all
 * on the same night. VERIFY_CHECKSUMS=always (environment or .env) verifies
 * every file on every search, as before.
 *
 * Read ahead (2026-11-11): with each shard a worker
 * tells its matcher which shard it will ask for next, and the matcher reads
 * that file while it matches the current one (libs/audfprint/match_server.py).
 *
 * --timeout <seconds>: a shard whose matcher has not answered by then is
 * reported as failed and its matcher stopped (the next shard starts a new one),
 * instead of one hung Python holding up its worker for good.
 */

const dotenv = require('dotenv')
const { spawn } = require('node:child_process')
const cluster = require('node:cluster')
const { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')
const readline = require('node:readline')
const { hideBin } = require('yargs/helpers')
const yargs = require('yargs/yargs')
const consts = require('../utils/consts')

dotenv.config()

const { argv } = yargs(hideBin(process.argv))

const FAILED_FILE = join(consts.TEMP_FOLDER, '_failed_pklzs.txt')
const CHECKPOINT_FILE = join(consts.TEMP_FOLDER, '_checkpoint.json')
const CHECKPOINT_VERSION = 1
const RESULTS_FLUSH_MS = 60_000 // keep _results.json and the checkpoint roughly current without rewriting them per shard
const STDERR_TAIL_BYTES = 4096
// Between a minute and a day. Node's timers hold at most 2^31 - 1 ms (24.8
// days) and fire at once when given more, which failed every shard on the spot.
const SHARD_TIMEOUT_MS = Math.min(Math.max(60, Number(argv.timeout) || 900), 24 * 60 * 60) * 1000

const MATCH_SUFFIX = '.match.txt'

// Verified checksums: see the header.
const VERIFIED_FILE = join(consts.INPUT_FOLDER, '..', 'cache', 'pklz-verified.json')
const VERIFIED_VERSION = 1
const CHECKSUM_REVERIFY_DAYS = 30
const VERIFY_ALWAYS = String(process.env.VERIFY_CHECKSUMS || '').trim().toLowerCase() === 'always'

// The temp file each shard's matches are collected in. A file name can turn up
// in several database folders - copies, or different files that happen to share
// a name (168 such names on 2026-11-05) - and when two of them shared one temp
// file and were matched at the same time, the first to finish was folded in and
// deleted while the other was still writing to it: the rest of that shard's
// matches were lost without a word. So the first shard with a name keeps
// "<name>.match.txt", the one a progress watcher looks for, and the n-th gets
// "<name>~n.match.txt". Counted without case, as NTFS compares names.
function assignMatchFiles(fingerprints){
    const seen = new Map()
    return fingerprints.map(fingerprint => {
        const name = basename(fingerprint)
        const n = (seen.get(name.toLowerCase()) || 0) + 1
        seen.set(name.toLowerCase(), n)
        return { fingerprint, matchFile: join(consts.TEMP_FOLDER, `${n === 1 ? name : `${name}~${n}`}${MATCH_SUFFIX}`) }
    })
}

// Same rules as werzatsong.js: "python", "py -3" or a full path with spaces.
function splitCommand(command){
    const trimmed = (command || '').trim()
    if(trimmed === '' || existsSync(trimmed))
        return { exe: trimmed || 'python', preArgs: [] }
    const parts = trimmed.split(/\s+/)
    return { exe: parts[0], preArgs: parts.slice(1) }
}

/* ---------------------------------------------------------------------------
 * Worker side
 *
 * Each worker keeps one Python matcher running and hands it one shard at a
 * time. It used to start `audfprint.py match` for every shard, and Python's
 * start-up and imports (numpy, scipy, joblib) took about 2.8 s each time -
 * some 34 CPU-hours over the ~43,000 shards of a full search. The matcher runs
 * the command line's own code, so what it writes for a shard is what
 * `audfprint.py match` printed for it. If it dies, only the shard it was on is
 * lost and the next shard starts a new one; every SHARDS_PER_MATCHER shards it
 * is replaced anyway, so nothing it holds can build up over a long run.
 * ------------------------------------------------------------------------ */

const MATCH_SERVER = join(dirname(consts.AUDFPRINT_PROGRAM), 'match_server.py')
const SHARDS_PER_MATCHER = 500

let matcher = null

function startMatcher(){
    const state = { child: null, pending: null, served: 0, stderrTail: '', gone: false, reason: null }
    const gone = reason => {
        if(state.gone)
            return
        state.gone = true
        state.reason = reason
        if(matcher === state)
            matcher = null
        const pending = state.pending
        state.pending = null
        if(pending){
            const lines = state.stderrTail.trim().split(/\r?\n/).filter(Boolean)
            pending.resolve({ ok: false, error: lines.length ? lines[lines.length - 1].trim() : reason })
        }
    }
    const { exe, preArgs } = splitCommand(process.env.PYTHON_COMMAND)
    try {
        // Argument array, no shell. The options of the former per-shard
        // `audfprint.py match` call; --dbase comes with each request.
        state.child = spawn(exe, [
            ...preArgs,
            MATCH_SERVER,
            '--min-count', '5',
            '--max-matches', '75',
            '--search-depth', '10000',
            '--list', consts.AFPTS_FILE
        ], { windowsHide: true })
    }
    catch(error){
        gone(`cannot start python: ${error.message}`)
        return state
    }
    const child = state.child
    // Replies are single JSON lines; anything else on stdout is ignored.
    readline.createInterface({ input: child.stdout }).on('line', line => {
        if(!line.startsWith('{'))
            return
        let reply
        try { reply = JSON.parse(line) }
        catch { return }
        const pending = state.pending
        if(!pending || reply.dbase !== pending.fingerprint)
            return
        state.pending = null
        pending.resolve(reply.ok === true
            ? { ok: true, verified: reply.verified === true && Number.isSafeInteger(reply.size) && /^\d+$/.test(String(reply.mtime_ns)) ? [reply.size, String(reply.mtime_ns)] : null }
            : { ok: false, error: reply.error || 'unknown error' })
    })
    child.stderr.on('data', chunk => {
        state.stderrTail = (state.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    child.stdin.on('error', () => { /* python is gone; 'close' reports it */ })
    child.on('error', error => gone(`cannot start python: ${error.message}`))
    child.on('close', code => gone(`python exited (code ${code})`))
    return state
}

// Resolves { ok, error }. Never rejects: a failure here must cost one shard,
// not the worker and everything still queued behind it.
function matchFingerprint({ fingerprint, matchFile, trusted }, next){
    return new Promise(resolve => {
        // Created before the matcher starts on it, so a progress watcher sees the
        // shard as in flight. The matcher appends the shard's output to it.
        try { closeSync(openSync(matchFile, 'a')) }
        catch(error){ return resolve({ ok: false, error: `cannot write match output: ${error.message}` }) }
        if(matcher && matcher.served >= SHARDS_PER_MATCHER){
            matcher.child.stdin.end() // end of input: that python exits
            matcher = null
        }
        if(!matcher)
            matcher = startMatcher()
        const state = matcher
        if(state.gone)
            return resolve({ ok: false, error: state.reason })
        // A matcher that does not answer in time is stopped; the shard counts
        // as failed and the next one gets a fresh matcher.
        const timer = setTimeout(() => {
            if(state.pending?.fingerprint !== fingerprint)
                return
            state.pending = null
            if(matcher === state)
                matcher = null
            state.gone = true
            state.reason = 'stopped after a timeout'
            try { state.child.kill() }
            catch { /* already gone */ }
            resolve({ ok: false, error: `no result after ${Math.round(SHARD_TIMEOUT_MS / 60000)} min, its matcher was stopped` })
        }, SHARD_TIMEOUT_MS)
        state.pending = { fingerprint, resolve: result => { clearTimeout(timer); resolve(result) } }
        state.served += 1
        const request = { dbase: fingerprint, out: matchFile }
        if(trusted)
            request.trusted = trusted
        if(next)
            request.next = next
        state.child.stdin.write(`${JSON.stringify(request)}\n`)
    })
}

function runWorker(){
    process.on('message', async ({ tasks }) => {
        for(let index = 0; index < tasks.length; index++){
            const task = tasks[index]
            let result
            try {
                result = await matchFingerprint(task, tasks[index + 1]?.fingerprint)
            }
            catch(error){
                result = { ok: false, error: error.message }
            }
            process.send({ status: 'done', fingerprint: task.fingerprint, ok: result.ok, error: result.error || null, verified: result.verified || null })
        }
    })
}

/* ---------------------------------------------------------------------------
 * Primary side
 * ------------------------------------------------------------------------ */

async function readMatches(resultsFile, basenameFingerprint, into){
    if(!existsSync(resultsFile))
        return
    let unreadable = 0
    const lines = readline.createInterface({ input: createReadStream(resultsFile, { encoding: 'utf-8' }), crlfDelay: Infinity })
    for await(const line of lines){
        if(!line.startsWith('{'))
            continue
        let parsed
        try { parsed = JSON.parse(line) }
        catch { unreadable += 1; continue } // a match killed mid-write can leave half a line
        const uniqueKey = `${parsed.input_file}:${parsed.matched_file}:${basenameFingerprint}`
        const existing = into[uniqueKey]
        if(!existing)
            into[uniqueKey] = { ...parsed, counter: 1 }
        else {
            if(parsed.common_hashes > existing.common_hashes){
                existing.common_hashes = parsed.common_hashes
                existing.total_hashes = parsed.total_hashes
                existing.match_time = parsed.match_time
                existing.rank_position = parsed.rank_position
            }
            existing.counter += 1
        }
    }
    try { unlinkSync(resultsFile) }
    catch { /* already gone; nothing to fold in twice */ }
    if(unreadable > 0)
        // stderr, so the orchestrator shows it as a warning: matches were lost
        console.error(`${unreadable} unreadable result line(s) from ${basenameFingerprint} were skipped`)
}

function sleepSync(ms){
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Written under a temporary name and renamed into place: a crash mid-write
// leaves the previous file, never half of a new one. Windows refuses to replace
// a file another program has open - Defender scanning it, an editor, a backup
// tool - so the rename is retried for about two seconds before it gives up.
function writeAtomically(path, text){
    const partial = `${path}.partial`
    writeFileSync(partial, text, 'utf-8')
    for(let attempt = 1; ; attempt++){
        try {
            renameSync(partial, path)
            return
        }
        catch(error){
            if(attempt >= 10)
                throw error
            sleepSync(200)
        }
    }
}

// --resume-from: the checkpoint of an earlier attempt at this search. Its
// results are the starting point, and its finished shards stay finished:
// failed ones stay failed too, because whatever they printed before failing
// is already in the results and searching them again would count it twice.
function readCheckpoint(path){
    try {
        const checkpoint = JSON.parse(readFileSync(path, 'utf-8'))
        if(checkpoint.version !== CHECKPOINT_VERSION || !Array.isArray(checkpoint.done) || typeof checkpoint.results !== 'object')
            throw new Error('not a checkpoint this version writes')
        return checkpoint
    }
    catch(error){
        console.error(`Cannot resume from ${path}: ${error.message}`)
        process.exit(1)
    }
}

// { path: [size, mtime_ns, verified at (ms)] }. Unreadable or from another
// version: start empty, every file is verified again.
function readVerified(){
    try {
        const stored = JSON.parse(readFileSync(VERIFIED_FILE, 'utf-8'))
        if(stored.version === VERIFIED_VERSION && stored.files && typeof stored.files === 'object')
            return stored.files
    }
    catch { /* none yet */ }
    return {}
}

// How long a verification of this file stands: CHECKSUM_REVERIFY_DAYS, give or
// take half, the same for a file every time (from its path).
function reverifyAfterMs(path){
    let hash = 0
    for(let i = 0; i < path.length; i++)
        hash = (hash * 31 + path.charCodeAt(i)) >>> 0
    return CHECKSUM_REVERIFY_DAYS * (0.5 + (hash % 1000) / 1000) * 24 * 60 * 60 * 1000
}

function runPrimary(){
    const threads = Math.max(1, Math.floor(Number(argv.threads)) || 1)
    const fingerprints = readFileSync(consts.PKLZS_FILE, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean)
    const tasks = assignMatchFiles(fingerprints)
    const verified = VERIFY_ALWAYS ? {} : readVerified()
    let verifiedDirty = false
    if(!VERIFY_ALWAYS){
        const now = Date.now()
        for(const task of tasks){
            const entry = verified[task.fingerprint]
            if(Array.isArray(entry) && entry.length === 3 && now - entry[2] >= 0 && now - entry[2] < reverifyAfterMs(task.fingerprint))
                task.trusted = [entry[0], entry[1]]
        }
    }
    // Losing this list only costs time: every file is verified again.
    const saveVerified = () => {
        if(VERIFY_ALWAYS || !verifiedDirty)
            return
        try {
            mkdirSync(dirname(VERIFIED_FILE), { recursive: true })
            writeAtomically(VERIFIED_FILE, JSON.stringify({ version: VERIFIED_VERSION, files: verified }))
            verifiedDirty = false
        }
        catch(error){ console.error(`Could not save the list of verified database files: ${error.message}`) }
    }
    const matchFiles = new Map(tasks.map(task => [task.fingerprint, task.matchFile]))
    const total = fingerprints.length
    const earlier = argv['resume-from'] ? readCheckpoint(String(argv['resume-from'])) : { done: [], results: {} }
    const results = earlier.results
    // { fingerprint, error } for every shard folded in, this attempt or earlier ones.
    const done = [...earlier.done]
    const failures = done.filter(entry => entry.error).map(({ fingerprint, error }) => ({ fingerprint, error }))
    const wholeSearch = total + done.length
    let finished = 0
    let exiting = false
    let dirty = false

    writeFileSync(consts.RESULTS_FILE, JSON.stringify(results), 'utf-8')
    writeFileSync(FAILED_FILE, '', 'utf-8')

    // Only ever called between two folds (from the fold chain or after it), so
    // the checkpoint's shard list and results always describe the same shards.
    const writeResults = () => {
        writeAtomically(consts.RESULTS_FILE, JSON.stringify(results))
        writeAtomically(CHECKPOINT_FILE, JSON.stringify({ version: CHECKPOINT_VERSION, done, results }))
        dirty = false
    }
    // A save that fails costs that save, never the search: the next one tries
    // again, and the end of the run tries harder. (An exception here used to
    // reject the fold chain with nothing to catch it, and Node ended the whole
    // matching stage.)
    const saveProgress = () => {
        try { writeResults() }
        catch(error){ console.error(`Could not save the results so far, trying again later: ${error.message}`) }
    }

    // Folding results in is serialised: each shard's file is read completely and
    // merged before the next one starts, and the run ends only after the last.
    let foldChain = Promise.resolve()
    const fold = (fingerprint, error) => {
        const basenameFingerprint = basename(fingerprint)
        foldChain = foldChain
            .then(() => readMatches(matchFiles.get(fingerprint), basenameFingerprint, results))
            .then(() => {
                done.push({ fingerprint, error: error || null })
                dirty = true
            })
            .catch(readError => {
                // Part of its rows may be in: it must not be searched again on resume.
                const reason = `its results could not be read: ${readError.message}`
                console.error(`Could not read the results of ${basenameFingerprint}: ${readError.message}`)
                done.push({ fingerprint, error: error || reason })
                if(!error)
                    failures.push({ fingerprint, error: reason })
                dirty = true
            })
        return foldChain
    }
    const flushTimer = setInterval(() => {
        foldChain = foldChain.then(() => { if(dirty) saveProgress() })
        saveVerified()
    }, RESULTS_FLUSH_MS)

    const finishIfDone = async () => {
        if(exiting || finished < total)
            return
        exiting = true
        await foldChain
        clearInterval(flushTimer)
        // werzatsong.js reads the results from this file, so it has to land.
        let saved = false
        for(let attempt = 1; attempt <= 5 && !saved; attempt++){
            try {
                writeAtomically(consts.RESULTS_FILE, JSON.stringify(results))
                saved = true
            }
            catch(error){
                console.error(`Could not save the results (attempt ${attempt} of 5): ${error.message}`)
                if(attempt < 5)
                    await new Promise(resolve => setTimeout(resolve, 3000))
            }
        }
        // The final checkpoint only matters if werzatsong.js dies before it has
        // reported, and an older one still resumes correctly: worth a try, not
        // worth failing the run over.
        try { writeAtomically(CHECKPOINT_FILE, JSON.stringify({ version: CHECKPOINT_VERSION, done, results })) }
        catch(error){ console.error(`Could not update the checkpoint: ${error.message}`) }
        saveVerified()
        if(failures.length > 0){
            try { writeAtomically(FAILED_FILE, failures.map(({ fingerprint, error }) => `${fingerprint}\t${error}`).join('\n') + '\n') }
            catch(error){ console.error(`Could not write the list of unsearched files: ${error.message}`) }
            console.error(`${failures.length} of ${wholeSearch} database file(s) could not be searched; listed in ${FAILED_FILE}`)
        }
        for(const worker of Object.values(cluster.workers))
            worker.kill()
        process.exit(saved ? 0 : 1)
    }

    const recordFailure = (fingerprint, error) => {
        failures.push({ fingerprint, error })
        // stderr, so the orchestrator surfaces it as a warning line
        console.error(`(${finished}/${total}) Analysis FAILED for: ${basename(fingerprint)} - ${error}`)
    }

    if(total === 0){
        finishIfDone()
        return
    }

    const chunks = Array.from({ length: threads }, () => [])
    tasks.forEach((task, index) => {
        chunks[index % threads].push(task)
    })

    for(const chunk of chunks){
        if(chunk.length === 0)
            continue
        const remaining = new Set(chunk.map(task => task.fingerprint))
        const worker = cluster.fork()
        worker.send({ tasks: chunk })
        worker.on('message', message => {
            if(message.status !== 'done' || !remaining.delete(message.fingerprint))
                return
            finished += 1
            const basenameFingerprint = basename(message.fingerprint)
            const error = message.ok ? null : (message.error || 'unknown error')
            if(message.ok && Array.isArray(message.verified) && !VERIFY_ALWAYS){
                verified[message.fingerprint] = [message.verified[0], message.verified[1], Date.now()]
                verifiedDirty = true
            }
            if(message.ok)
                console.log(`(${finished}/${total}) Analysis completed for: ${basenameFingerprint}`)
            else
                recordFailure(message.fingerprint, error)
            // Fold even a failed shard: whatever it printed before failing is still valid.
            fold(message.fingerprint, error).then(finishIfDone)
        })
        // A worker that dies with shards left would otherwise leave the run
        // waiting for them forever. Count them as failed and carry on.
        worker.on('exit', (code, signal) => {
            if(exiting || remaining.size === 0)
                return
            const reason = `worker exited unexpectedly (${signal || `code ${code}`})`
            for(const fingerprint of remaining){
                finished += 1
                recordFailure(fingerprint, reason)
            }
            remaining.clear()
            finishIfDone()
        })
    }
}

if(cluster.isPrimary)
    runPrimary()
else
    runWorker()
