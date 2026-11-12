/*
 * WerZatSong — main orchestrator (performance & observability revision)
 * Based on https://github.com/Nel80s/WerZatSong by Nel, with contributions
 * from Numerophobe, AzureBlast and Mystic65.
 *
 * What changed in this revision and why (short version):
 *
 *  PERFORMANCE
 *  - The ffmpeg-trim -> audfprint-precompute loop now runs in a bounded
 *    parallel pool instead of strictly one file at a time. These are
 *    independent CPU-bound jobs, so this alone cuts prep time roughly by
 *    the number of cores used.
 *  - Precomputed query fingerprints (.afpt) are cached in a persistent
 *    "cache/afpt" folder, keyed by the source file's content hash plus the
 *    trim/shifts settings and a tag for the tools that made it (python,
 *    numpy, scipy, ffmpeg, the fingerprinting code; utils/toolchain.js), so
 *    an updated tool never mixes old and new fingerprints. Re-running the same unknown clips (the normal
 *    lostwave workflow: same samples vs. an ever-growing database) skips
 *    ffmpeg + audfprint precompute entirely.
 *  - Query-side --shifts is now configurable (default 4, the old hardcoded
 *    value). Shifts multiply query hashes and part of the match cost. For a
 *    while the default was 2; on 2026-11-05, 24 lostwave clips against the
 *    WatZatSong folder got 30-140% more aligned hashes at 4 than at 2 for
 *    their real matches (two PROBABLE became STRONG), with no extra noise, so
 *    4 is back. --shifts 2 remains the quick option.
 *  - New "--merge" utility mode consolidates a database subfolder's many
 *    .pklz files into a few large shards via audfprint's newmerge. audfprint
 *    reloads (gunzip + unpickle) every database file on every match run, so
 *    hundreds of small pklz files pay that load cost hundreds of times.
 *    Fewer, larger shards remove most of that overhead - but only while the
 *    merged table has room: every table has the same fixed capacity and full
 *    buckets drop hashes at random, so a shard losing more than --max-dropped
 *    (default 3%) is discarded, and whole-database searches skip "__merged"
 *    folders so they never search the same material twice.
 *
 *  CORRECTNESS
 *  - All child processes are launched with execFile/spawn and argument
 *    arrays instead of shell command strings. This removes shell-injection
 *    risk from filenames containing quotes/spaces/metacharacters and avoids
 *    exec()'s maxBuffer kills on verbose output.
 *  - stderr from the audfprint worker is no longer fatal. Python/numpy/
 *    librosa routinely print harmless warnings to stderr; success is now
 *    decided by the exit code (with the MemoryError hint preserved).
 *  - One bad/corrupt/too-short input file no longer aborts the whole batch;
 *    it is skipped with a warning and the rest continue.
 *  - stdout from the worker is line-buffered (readline) so log lines can't
 *    interleave mid-line under load.
 *  - MusicBrainz result lines are accumulated across output chunks (the old
 *    code overwrote the array on each line, keeping only the last one).
 *  - Webhook posting failures are caught and logged instead of crashing.
 *
 *  VISIBILITY / EXPLAINABILITY
 *  - Match scoring is re-framed in audfprint's own terms:
 *      aligned  = time-consistent common hashes  (this is the real evidence;
 *                 audfprint's README: >5-6 aligned hashes usually indicates
 *                 a true match)
 *      raw      = all common hashes before time filtering
 *      cons%    = aligned / raw  (random chance stays under ~1%)
 *    The old "match_score" was exactly cons%, but the code treated it as a
 *    generic percentage. Thresholds are named, documented and produce a human
 *    label (very strong / strong / probable / borderline); since 2026-11-06
 *    they are an eight-step ladder of aligned hashes and consistency, and
 *    nothing under 2% consistency is posted (see the thresholds).
 *  - Each input gets ONE result artifact: a human-readable .txt log with a
 *    legend and the same entry formatting used for the Discord webhook.
 *    (An earlier revision also wrote a machine-readable .ndjson alongside
 *    it; that was removed since nothing in this workflow consumes it.)
 *  - A final ranked summary per query is printed at the end of the run,
 *    plus per-phase timing.
 */

const dotenv = require('dotenv')
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { availableParallelism, freemem } = require('node:os')
const { basename, dirname, extname, join, parse, resolve } = require('node:path')
const readline = require('node:readline')
const { promisify } = require('node:util')
const { hideBin } = require('yargs/helpers')
const yargs = require('yargs/yargs')
const { searchWithAudiotag } = require('./scripts/audiotag')
const consts = require('./utils/consts')
const { generateUnique, sleep, trimExtension } = require('./utils/helpers')
const runLock = require('./utils/lock')
const { empty, exit, info, success, warning } = require('./utils/messages')
const { checkToolchain, describeToolchain, fingerprintRecipe } = require('./utils/toolchain')
const { validateAudiotag, validateDuration, validateExtension, validateMusicbrainz, validateWebhook } = require('./utils/validators')
const postWebhook = require('./utils/webhook')
const { neutraliseMentions } = postWebhook

require('node:events').setMaxListeners(100) // increase listeners limit

/*
 * ---- audfprint match confidence thresholds --------------------------------
 * Primary evidence is the ABSOLUTE number of time-aligned hashes ("aligned"),
 * per audfprint's README: anything more than 5-6 consistently-timed matching
 * hashes usually indicates a true match, while random chance keeps the
 * aligned/raw consistency fraction under ~1%.
 *
 * Since 2026-11-06 the decision is a ladder: each step
 * pairs a number of aligned hashes ("amount") with the aligned/raw percentage
 * ("score") it needs, fewer hashes needing a higher share. The steps map onto
 * the existing labels, so result files and Discord posts look as before:
 *   EXTREME                    -> very strong
 *   HIGHEST, HIGHER            -> strong
 *   HIGH, MEDIUM, LOW, LOWER,
 *   LOWEST                     -> probable
 * and nothing under AUDFPRINT_WEBHOOK_MIN_SCORE % is posted, however many
 * hashes line up: such a match is at most 'borderline' (in the result file,
 * for a manual look).
 *
 * Previous rule set, for comparison: 70+ aligned; 40 @ 2%; 25 @ 7%; 15 @ 30%.
 * On the 26 queries of 2026-11-05/06 the ladder would have posted 1,380
 * entries instead of 303 - with query --shifts 4 a chance match gets 15-20
 * "aligned" hashes out of only 3-4 distinct ones (Nachts vs bandcamp).
 *
 * A tool that labels results the same way may read these constants by name:
 * keep the names, or change both.
 */
const AUDFPRINT_LOWEST_HASHES = 13      // amount
const AUDFPRINT_LOWEST_SCORE = 10       // percentage
const AUDFPRINT_LOWER_HASHES = 15       // amount
const AUDFPRINT_LOWER_SCORE = 8         // percentage
const AUDFPRINT_LOW_HASHES = 17         // amount
const AUDFPRINT_LOW_SCORE = 7           // percentage
const AUDFPRINT_MEDIUM_HASHES = 20      // amount
const AUDFPRINT_MEDIUM_SCORE = 6        // percentage
const AUDFPRINT_HIGH_HASHES = 25        // amount
const AUDFPRINT_HIGH_SCORE = 5          // percentage
const AUDFPRINT_HIGHER_HASHES = 40      // amount
const AUDFPRINT_HIGHER_SCORE = 3        // percentage
const AUDFPRINT_HIGHEST_HASHES = 45     // amount
const AUDFPRINT_HIGHEST_SCORE = 2       // percentage
const AUDFPRINT_EXTREME_HASHES = 65     // amount
const AUDFPRINT_WEBHOOK_MIN_SCORE = 2   // percentage: nothing below this is posted
const AUDFPRINT_REVIEW_ALIGNED = 10     // below every step, but worth a manual look (log-only)

// Strongest step first; the first one a match reaches gives its label.
const AUDFPRINT_LADDER = [
    { hashes: AUDFPRINT_EXTREME_HASHES, score: 0, label: 'very strong' },
    { hashes: AUDFPRINT_HIGHEST_HASHES, score: AUDFPRINT_HIGHEST_SCORE, label: 'strong' },
    { hashes: AUDFPRINT_HIGHER_HASHES, score: AUDFPRINT_HIGHER_SCORE, label: 'strong' },
    { hashes: AUDFPRINT_HIGH_HASHES, score: AUDFPRINT_HIGH_SCORE, label: 'probable' },
    { hashes: AUDFPRINT_MEDIUM_HASHES, score: AUDFPRINT_MEDIUM_SCORE, label: 'probable' },
    { hashes: AUDFPRINT_LOW_HASHES, score: AUDFPRINT_LOW_SCORE, label: 'probable' },
    { hashes: AUDFPRINT_LOWER_HASHES, score: AUDFPRINT_LOWER_SCORE, label: 'probable' },
    { hashes: AUDFPRINT_LOWEST_HASHES, score: AUDFPRINT_LOWEST_SCORE, label: 'probable' },
]

const BUSY_EXIT_CODE = 75                  // another run holds the install's lock (EX_TEMPFAIL); launchers may retry later
const DEFAULT_QUERY_SHIFTS = 4             // query-side --shifts (the old hardcoded value; 2 for a quicker search; see header)
const FAILED_PKLZS_FILE = join(consts.TEMP_FOLDER, '_failed_pklzs.txt') // written by scripts/audfprint.js
const DEFAULT_MERGE_SHARD_FILES = 64       // source pklz files merged per output shard in --merge mode
const DEFAULT_MERGE_MAX_DROPPED = 3        // % of hashes a merged shard may lose to full buckets before it is discarded
const MAX_FILES_PER_SEARCH = 30            // amount
const MAX_PREP_CONCURRENCY = 16             // upper bound for parallel ffmpeg/precompute workers STANDARD: 8
const MUSICBRAINZ_MIN_SCORE = 60           // percentage
const PROGRAM_VERSION = 'v1.0.0'
const RESULTS_FOLDER = join(consts.LOGS_FOLDER, generateUnique())
const SHAZAM_SLEEP = 1.5                   // seconds
const WEBHOOK_SLEEP = 2                    // seconds between Discord posts (coarse rate limiting)
const DEFAULT_SHARD_TIMEOUT = 15           // minutes one database file may take before its matcher is stopped
// Memory one matching thread needs at its peak, while it loads a database file:
// every table inflates to ~424 MB, and libs/audfprint/hash_table.py inflates it
// in place (about 460 MB at the peak, measured 2026-11-06; the older loader
// briefly held two copies, ~850 MB). The rest is room for the matching itself.
const MATCHER_PEAK_BYTES = 0.6 * 2 ** 30
const MEMORY_HEADROOM_BYTES = 4 * 2 ** 30  // left for Windows and everything else running here
const DISK_WARN_BYTES = 2 * 2 ** 30        // free space below this on the drive of temp/, logs/ or the cache gets a warning
// Written while the matching stage runs, so --resume can continue it (see resumeSearch).
const RUN_STATE_FILE = join(consts.TEMP_FOLDER, '_run.json')
const CHECKPOINT_FILE = join(consts.TEMP_FOLDER, '_checkpoint.json') // written by scripts/audfprint.js
const ALL_PKLZS_FILE = join(consts.TEMP_FOLDER, '_pklzs_all.txt')

// Persistent query-fingerprint cache. Lives NEXT TO the input folder (i.e.
// "<project>/cache/afpt") and is intentionally NOT wiped by setupFolders().
const CACHE_FOLDER = join(consts.INPUT_FOLDER, '..', 'cache', 'afpt')

const Mode = {
    AUDFPRINT: 'audfprint',
    AUDIOTAG: 'audiotag',
    MUSICBRAINZ: 'musicbrainz',
    SHAZAM: 'shazam'
}

const execFileP = promisify(execFile)
const { argv } = yargs(hideBin(process.argv))
// Program version
.version(PROGRAM_VERSION)
// Search modes
.option(Mode.AUDFPRINT, { type: 'boolean', description: 'Enable Audfprint-based matching' })
.option(Mode.AUDIOTAG, { type: 'boolean', description: 'Enable search using the Audiotag API' })
.option(Mode.MUSICBRAINZ, { type: 'boolean', description: 'Enable search using MusicBrainz (AcoustID API)' })
.option(Mode.SHAZAM, { type: 'boolean', description: 'Enable search using Shazam API' })
// Global options
.option('trim', { type: 'number', description: 'Trim MP3 files to the specified length (in seconds) before processing' })
// MusicBrainz options
.option('duration', { type: 'string', description: 'Set the allowed duration range for MusicBrainz searches (format: "min:max")' })
.option('extension', { type: 'number', description: 'Extend MP3 files by the specified number of seconds before MusicBrainz analysis' })
// Audfprint options
.option('folder', { type: 'string', description: 'Specify the subfolder containing PKLZ files to be used in Audfprint mode' })
.option('threads', { type: 'number', description: 'Set the number of threads to use for Audfprint processing' })
.option('shifts', { type: 'number', description: `Query-side audfprint --shifts (1-8). Higher = more robust but slower; default ${DEFAULT_QUERY_SHIFTS}, 2 for a quicker search` })
.option('shard-timeout', { type: 'number', description: `Minutes one database file may take before its matcher is stopped and the file is reported as failed (default ${DEFAULT_SHARD_TIMEOUT})` })
.option('resume', { type: 'boolean', description: 'Continue an audfprint search that stopped part-way (crash, cancel, watchdog): only the database files it had not finished are searched, then the results are reported as usual' })
// Database maintenance
.option('merge', { type: 'string', description: 'Merge the PKLZ files in "database/<folder>" into a few large shards (major speedup), then exit. Pass "" for the database root' })
.option('shard-files', { type: 'number', description: `In --merge mode, how many source PKLZ files go into each merged shard (default ${DEFAULT_MERGE_SHARD_FILES})` })
.option('max-dropped', { type: 'number', description: `In --merge mode, discard a merged shard that loses more than this % of its hashes to full buckets, keeping its sources as they are (default ${DEFAULT_MERGE_MAX_DROPPED})` })

/* ---------------------------------------------------------------------------
 * Small generic helpers
 * ------------------------------------------------------------------------ */

// Split an env-provided command like "python3" / "C:\Python\python.exe" /
// "py -3" into executable + leading args, so it can be used with execFile
// and spawn (argument arrays, no shell). If the whole string is an existing
// file path (may contain spaces), it is used as-is.
function splitCommand(command){
    const trimmed = (command || '').trim()
    if(trimmed === '')
        return { exe: trimmed, preArgs: [] }
    if(existsSync(trimmed))
        return { exe: trimmed, preArgs: [] }
    const parts = trimmed.split(/\s+/)
    return { exe: parts[0], preArgs: parts.slice(1) }
}

// execFile wrapper: no shell (filenames with spaces/quotes/metacharacters are
// safe), generous maxBuffer, hidden console windows on Windows.
function runTool(command, args, options = {}){
    const { exe, preArgs } = splitCommand(command)
    return execFileP(exe, [...preArgs, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        ...options
    })
}

// Bounded-concurrency pool. Preserves input order in the returned array and
// never rejects as long as `worker` handles its own errors.
async function runPool(items, limit, worker){
    const results = new Array(items.length)
    let next = 0
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while(next < items.length){
            const index = next++
            results[index] = await worker(items[index], index)
        }
    })
    await Promise.all(lanes)
    return results
}

// Streaming SHA-1 of a file's contents (cache key ingredient).
function hashFile(path){
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1')
        const stream = createReadStream(path)
        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

// Recursively look for an exact filename below `dir` (used to locate the
// .afpt that audfprint precompute wrote, wherever it mirrored it).
function findFileRecursively(dir, filename){
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch { return null }
    for(const entry of entries){
        const fullPath = join(dir, entry.name)
        if(entry.isDirectory()){
            const found = findFileRecursively(fullPath, filename)
            if(found)
                return found
        }
        else if(entry.isFile() && entry.name === filename)
            return fullPath
    }
    return null
}

// The worker emits some fields pre-decorated for display: rank_position
// arrives as "#0" and match_time as "-3.53s". Those strings are useless in
// the machine-readable NDJSON output, and re-adding "#"/"s" on top of them
// produces "##0" / "-3.53ss". Strip to a plain number on parse; the display
// layer re-adds the decoration.
function parseNumericField(value){
    if(typeof value === 'number')
        return value
    const parsed = parseFloat(String(value ?? '').replace(/[^0-9.eE+-]/g, ''))
    return isNaN(parsed) ? 0 : parsed
}

function formatSeconds(ms){
    const totalSeconds = Math.round(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

// audfprint's precomputed-hash file: a 16-byte magic, then one 8-byte
// (time, hash) record per landmark (audfprint_analyze.py HASH_MAGIC/HASH_FMT).
// A query that is not one of these - wrong header, truncated, no landmarks -
// makes `audfprint.py match` raise at that query, and that ends the match of
// that query and every query listed after it, in every shard of the run.
// Returns why a file is unusable, or null when it is fine.
const AFPT_MAGIC = Buffer.from('audfprinthashV00', 'latin1')
const AFPT_RECORD_BYTES = 8
function afptProblem(path){
    let size
    try { size = statSync(path).size }
    catch(error){ return `cannot read it: ${error.message}` }
    if(size < AFPT_MAGIC.length + AFPT_RECORD_BYTES || (size - AFPT_MAGIC.length) % AFPT_RECORD_BYTES !== 0)
        return `${size} bytes is not a whole number of fingerprint records`
    const head = Buffer.alloc(AFPT_MAGIC.length)
    let fd
    try {
        fd = openSync(path, 'r')
        readSync(fd, head, 0, head.length, 0)
    }
    catch(error){ return `cannot read it: ${error.message}` }
    finally { if(fd !== undefined) closeSync(fd) }
    return head.equals(AFPT_MAGIC) ? null : 'it does not start with the audfprint fingerprint header'
}

/* ---------------------------------------------------------------------------
 * Setup / input loading
 * ------------------------------------------------------------------------ */

// keepSearchState: --resume continues the search kept in temp/ (run state,
// checkpoint, database list) with the query fingerprints in precomputed/, so
// only processed/ is emptied.
function setupFolders({ keepSearchState = false } = {}){
    const foldersToClean = keepSearchState
        ? [consts.PROCESSED_FOLDER]
        : [consts.PRECOMPUTED_FOLDER, consts.PROCESSED_FOLDER, consts.TEMP_FOLDER]
    // Emptied, not deleted and re-created. Windows refuses to remove a directory
    // while anything else has it open - a shell or Explorer window sitting in it,
    // a file watcher - and that EPERM used to end the run before it had started
    // (two runs in a row, on 2026-09-22 and 2026-09-23).
    for(const folder of foldersToClean){
        if(!existsSync(folder)){
            mkdirSync(folder)
            continue
        }
        for(const entry of readdirSync(folder))
            rmSync(join(folder, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    const foldersToCreate = [
        consts.PRECOMPUTED_FOLDER,
        consts.PROCESSED_FOLDER,
        consts.TEMP_FOLDER,
        consts.DATABASE_FOLDER,
        consts.INPUT_FOLDER,
        consts.LOGS_FOLDER
    ]
    for(const folder of foldersToCreate){
        if(!existsSync(folder))
            mkdirSync(folder)
    }
    // The fingerprint cache persists across runs on purpose - do NOT add it
    // to foldersToClean. It is what makes repeat searches fast.
    if(!existsSync(CACHE_FOLDER))
        mkdirSync(CACHE_FOLDER, { recursive: true })
}

function fetchEnvironment(){
    if(!existsSync(consts.ENV_FILE))
        copyFileSync(consts.EXAMPLE_ENV_FILE, consts.ENV_FILE)
    const { parsed } = dotenv.config()
    return parsed
}

function parseModes(){
    const modes = []
    if(argv.audfprint)
        modes.push(Mode.AUDFPRINT)
    if(argv.audiotag)
        modes.push(Mode.AUDIOTAG)
    if(argv.musicbrainz)
        modes.push(Mode.MUSICBRAINZ)
    if(argv.shazam)
        modes.push(Mode.SHAZAM)
    if(modes.length === 0)
        exit(`Please choose at least one search mode (${Object.values(Mode).map(value => `--${value}`).join(', ')})`)
    return modes
}

function loadSamples(modes){
    // Single directory read, partitioned by extension (the previous version
    // scanned the folder twice).
    const inputEntries = readdirSync(consts.INPUT_FOLDER)
    const audioFiles = inputEntries.filter(filename => filename.toLowerCase().endsWith('.mp3'))
    const precomputedFiles = inputEntries.filter(filename => filename.toLowerCase().endsWith('.afpt'))
    if(modes.some(mode => mode !== Mode.AUDFPRINT) && audioFiles.length === 0)
        exit(`You need at least one MP3 file in the "input" folder if you included mode: ${Mode.AUDIOTAG}, ${Mode.MUSICBRAINZ} or ${Mode.SHAZAM}`)
    if(audioFiles.length > MAX_FILES_PER_SEARCH)
        exit(`Too many MP3 files! Limit per each search is ${MAX_FILES_PER_SEARCH} files, but found ${audioFiles.length} files (MP3)`)
    if(modes.includes(Mode.AUDFPRINT) && audioFiles.length === 0 && precomputedFiles.length === 0)
        exit(`In ${Mode.AUDFPRINT} mode, add at least one MP3 or AFPT file to "input" folder`)
    const mp3Basenames = audioFiles.map(file => trimExtension(file))
    // Compared without case: both kinds end up as precomputed/<name>.afpt, and
    // on NTFS "x.mp3" and "X.afpt" would land on the same file.
    const afptBasenames = new Set(precomputedFiles.map(file => trimExtension(file).toLowerCase()))
    const collisions = mp3Basenames.filter(base => afptBasenames.has(base.toLowerCase()))
    if(collisions.length > 0){
        const collisionFiles = collisions.map(base => `- ${base}.mp3 / ${base}.afpt\n`).join('')
        exit(`Duplicated filename collisions detected in "input" folder:\n${collisionFiles}`)
    }
    const totalFiles = audioFiles.length + precomputedFiles.length
    if(modes.includes(Mode.AUDFPRINT) && totalFiles > MAX_FILES_PER_SEARCH)
        exit(`Too many files! Limit per each ${Mode.AUDFPRINT} search is ${MAX_FILES_PER_SEARCH} files, but found ${totalFiles} files (MP3 + AFPT)`)
    return { audioFiles, precomputedFiles }
}

/* ---------------------------------------------------------------------------
 * Query preparation (trim + precompute), parallel with caching
 * ------------------------------------------------------------------------ */

// Returns true on success. Failures are warnings (skip file), never fatal.
async function trimFile(ffmpegCommand, filename, seconds){
    try {
        const originalPath = join(consts.INPUT_FOLDER, filename)
        const trimmedPath = join(consts.PROCESSED_FOLDER, filename)
        await runTool(ffmpegCommand, ['-i', originalPath, '-y', '-t', String(seconds), trimmedPath])
        return true
    }
    catch(error){
        warning(`Failed to trim "${filename}" - the file will be skipped: ${error.message}`)
        return false
    }
}

// Runs audfprint precompute on processed/<filename>. Locates the produced
// .afpt (audfprint may mirror the input path under --precompdir), moves it to
// the top of the precomputed folder under the query's own basename, and
// returns that path - or null if the file was skipped.
async function precomputeFile(pythonCommand, filename, shifts){
    const sourcePath = join(consts.PROCESSED_FOLDER, filename)
    const afptName = `${trimExtension(filename)}.afpt`
    const targetPath = join(consts.PRECOMPUTED_FOLDER, afptName)
    try {
        const { stdout } = await runTool(pythonCommand, [
            consts.AUDFPRINT_PROGRAM,
            'precompute',
            '--precompdir', consts.PRECOMPUTED_FOLDER,
            '--shifts', String(shifts),
            sourcePath
        ])
        if(stdout.includes('Zero length analysis')){
            warning(`File "${filename}" is too short to be precomputed, will be skipped in ${Mode.AUDFPRINT} mode`)
            return null
        }
        if(existsSync(targetPath))
            return targetPath
        const produced = findFileRecursively(consts.PRECOMPUTED_FOLDER, afptName)
        if(produced){
            if(produced !== targetPath)
                copyFileSync(produced, targetPath)
            return targetPath
        }
        warning(`Precompute reported success for "${filename}" but no "${afptName}" was found - skipping this file`)
        return null
    }
    catch(error){
        warning(`Failed to precompute "${filename}" - the file will be skipped: ${error.message}`)
        return null
    }
}

// Written under a temporary name and renamed into place, so a run stopped
// mid-copy never leaves a half-written entry for later runs to reuse.
function storeInCache(source, cachedPath){
    const partial = `${cachedPath}.${process.pid}.partial`
    try {
        copyFileSync(source, partial)
        renameSync(partial, cachedPath)
    }
    catch {
        try { unlinkSync(partial) }
        catch { /* nothing was left behind */ }
    }
}

// recipe: utils/toolchain.js fingerprintRecipe() - python, numpy, scipy, the
// ffmpeg that decodes (and the one that trims) and the fingerprinting code.
// It is part of the cache key, so updating any of them makes old entries miss
// instead of mixing fingerprints made two different ways.
async function generateFiles(env, trimSeconds, shifts, modes, audioFiles, precomputedFiles, recipe){
    const filesToProcess = { afpts: [], mp3s: [] }
    const wantAfpt = modes.includes(Mode.AUDFPRINT)
    const needMp3 = modes.some(mode => mode !== Mode.AUDFPRINT)
    const trimming = !isNaN(Number(trimSeconds)) && trimSeconds > 0
    let skipped = 0
    let cacheHits = 0

    if(audioFiles?.length > 0){
        const concurrency = Math.max(1, Math.min(availableParallelism(), MAX_PREP_CONCURRENCY, audioFiles.length))
        if(audioFiles.length > 1)
            info(`Preparing ${audioFiles.length} input file(s) with up to ${concurrency} parallel worker(s)`)

        const prepared = await runPool(audioFiles, concurrency, async audioFile => {
            const result = { mp3: null, afpt: null, ok: true }
            const originalPath = join(consts.INPUT_FOLDER, audioFile)
            const processedPath = join(consts.PROCESSED_FOLDER, audioFile)

            // Cache lookup happens against the ORIGINAL file's content, so a
            // hit lets us skip both ffmpeg and precompute. The key includes
            // trim + shifts because either changes the fingerprint.
            let cachedPath = null
            let cacheHit = false
            if(wantAfpt){
                try {
                    const contentHash = await hashFile(originalPath)
                    cachedPath = join(CACHE_FOLDER, `${contentHash}-t${trimming ? trimSeconds : 0}-s${shifts}-r${recipe}.afpt`)
                    // A damaged entry counts as a miss, so it is recomputed and
                    // replaced instead of being handed to every shard.
                    cacheHit = existsSync(cachedPath) && afptProblem(cachedPath) === null
                }
                catch { /* unreadable file: treat as cache miss, surface errors below */ }
            }

            // processed/<file>: the trimmed (or copied) input that the other
            // modes and audfprint precompute read.
            let processedReady = false
            const prepareProcessed = async () => {
                if(processedReady)
                    return true
                if(trimming){
                    if(!await trimFile(env.FFMPEG_COMMAND, audioFile, trimSeconds))
                        return false
                }
                else {
                    try { copyFileSync(originalPath, processedPath) }
                    catch(error){
                        warning(`Failed to copy "${audioFile}" - the file will be skipped: ${error.message}`)
                        return false
                    }
                }
                processedReady = true
                return true
            }

            const needProcessed = needMp3 || (wantAfpt && !cacheHit)
            if(needProcessed){
                if(!await prepareProcessed()){
                    result.ok = false
                    return result
                }
                if(needMp3)
                    result.mp3 = processedPath
            }

            if(wantAfpt){
                const targetAfpt = join(consts.PRECOMPUTED_FOLDER, `${trimExtension(audioFile)}.afpt`)
                if(cacheHit){
                    try {
                        copyFileSync(cachedPath, targetAfpt)
                        result.afpt = targetAfpt
                        cacheHits += 1
                        return result
                    }
                    catch { /* unreadable cache entry: fall through and recompute */ }
                    // The hit skipped making processed/<file>, and precompute
                    // reads it.
                    if(!await prepareProcessed()){
                        result.ok = false
                        return result
                    }
                }
                const produced = await precomputeFile(env.PYTHON_COMMAND, audioFile, shifts)
                if(produced){
                    result.afpt = produced
                    // Only a well-formed fingerprint is worth keeping; a cache
                    // write failure is non-fatal.
                    if(cachedPath && afptProblem(produced) === null)
                        storeInCache(produced, cachedPath)
                }
            }
            return result
        })

        for(const item of prepared){
            if(!item.ok){
                skipped += 1
                continue
            }
            if(item.mp3)
                filesToProcess.mp3s.push(item.mp3)
            if(item.afpt)
                filesToProcess.afpts.push(item.afpt)
        }
        if(cacheHits > 0)
            success(`Fingerprint cache: reused ${cacheHits} of ${audioFiles.length} query fingerprint(s) from previous runs (skipped ffmpeg + precompute)`)
        if(skipped > 0)
            warning(`Skipped ${skipped} input file(s) due to errors above; continuing with the rest`)
        if(skipped === audioFiles.length && audioFiles.length > 0 && precomputedFiles?.length === 0)
            exit('Every input file failed to prepare - nothing to search with')
    }

    if(wantAfpt && precomputedFiles?.length > 0){
        for(const precomputedFile of precomputedFiles){
            const source = join(consts.INPUT_FOLDER, precomputedFile)
            const problem = afptProblem(source)
            if(problem){
                warning(`"${precomputedFile}" is not a usable audfprint fingerprint (${problem}) - the file will be skipped`)
                continue
            }
            // Always ".afpt" in lower case: audfprint reads a query as a
            // fingerprint only when its name ends in exactly that, and tries
            // to decode anything else - ".AFPT" included - as audio.
            const target = join(consts.PRECOMPUTED_FOLDER, `${trimExtension(precomputedFile)}.afpt`)
            copyFileSync(source, target)
            filesToProcess.afpts.push(target)
        }
    }
    return filesToProcess
}

/* ---------------------------------------------------------------------------
 * Results logging
 * ------------------------------------------------------------------------ */

function createResultsLog(basename, mode, content){
    if(!existsSync(RESULTS_FOLDER))
        mkdirSync(RESULTS_FOLDER)
    const resultsFile = join(RESULTS_FOLDER, `${basename}.${mode}.txt`)
    writeFileSync(resultsFile, content)
    return resultsFile
}

// `skipMerged`: leave out "<name>__merged" folders (--merge output). They hold
// copies of shards that are still in place, so a whole-database search that
// walked into them would search the same material twice and report every
// match from it twice. Searching one explicitly with --folder still works.
function fetchFingerprints(targetFolder, { skipMerged = false } = {}){
    let pklzFiles = []
    const fetchFilesRecursively = dir => {
        const files = readdirSync(dir, { withFileTypes: true })
        for(const file of files){
            const fullPath = join(dir, file.name)
            if(file.isDirectory() && skipMerged && file.name.endsWith('__merged'))
                continue
            if(file.isDirectory())
                fetchFilesRecursively(fullPath)
            else if(file.isFile() && file.name.endsWith('.pklz'))
                pklzFiles.push(fullPath)
        }
    }
    fetchFilesRecursively(targetFolder)
    return pklzFiles
}

function setupAudfprint(folder){
    const baseFolder = join(consts.DATABASE_FOLDER, folder ? folder.trim() : '')
    if(!existsSync(baseFolder))
        exit(`The specified folder "${folder}" does not exist inside "database/"`)
    const explicitMerged = Boolean(folder) && folder.trim().replace(/[\\/]+$/, '').endsWith('__merged')
    const pklzFiles = fetchFingerprints(baseFolder, { skipMerged: !explicitMerged })
    if(pklzFiles.length === 0)
        exit(`No PKLZ files found in "${baseFolder}"`)
    writeFileSync(consts.PKLZS_FILE, pklzFiles.join('\n'))
    return pklzFiles.length
}

/* ---------------------------------------------------------------------------
 * audfprint worker invocation
 * ------------------------------------------------------------------------ */

// timeoutSeconds: how long one database file may take before its matcher is
// stopped. resumeFrom: a checkpoint of an earlier, unfinished attempt whose
// results the worker starts from (only the files it had not finished are in
// temp/_pklzs.txt then).
function audfprint(env, threads, { timeoutSeconds, resumeFrom = null } = {}){
    return new Promise((resolve, reject) => {
        const { exe, preArgs } = splitCommand(env.NODE_COMMAND)
        const audfprintProcess = spawn(exe, [
            ...preArgs,
            consts.AUDFPRINT_SCRIPT,
            '--threads', String(threads),
            '--timeout', String(timeoutSeconds),
            ...(resumeFrom ? ['--resume-from', resumeFrom] : [])
        ], { windowsHide: true })
        const stderrTail = []

        // Line-buffered reads: child stdout "data" events can split mid-line,
        // which used to interleave and corrupt log lines under load.
        readline.createInterface({ input: audfprintProcess.stdout }).on('line', line => {
            if(line.trim() !== '')
                info(line.trim())
        })
        // stderr is NOT fatal anymore. numpy/librosa/audfprint emit harmless
        // warnings and progress there; success is decided by the exit code.
        readline.createInterface({ input: audfprintProcess.stderr }).on('line', line => {
            const text = line.trim()
            if(text === '')
                return
            stderrTail.push(text)
            if(stderrTail.length > 40)
                stderrTail.shift()
            warning(`[worker stderr] ${text}`)
        })
        audfprintProcess.on('error', error => {
            exit(`Failed to launch the ${Mode.AUDFPRINT} worker: ${error.message}`)
        })
        audfprintProcess.on('close', code => {
            if(code === 0)
                return resolve()
            const tail = stderrTail.join('\n')
            if(tail.includes('MemoryError'))
                exit('The process ran out of memory. Please try reducing the number of threads (or merge/shard your database with --merge) and run it again')
            warning(`Mode ${Mode.AUDFPRINT} exited with error code: ${code}`)
            if(tail !== '')
                warning(`Last worker stderr output:\n${tail}`)
            reject(new Error(`audfprint worker exited with code ${code}`))
        })
    })
}

/* ---------------------------------------------------------------------------
 * audfprint results: scoring, human + machine logs, summary
 * ------------------------------------------------------------------------ */

// Human-readable confidence label from the ladder above. 'very strong',
// 'strong' and 'probable' are posted; 'borderline' is log-only (review
// manually); null means not worth listing as a match.
function classifyMatch(aligned, consistencyPct){
    if(consistencyPct < AUDFPRINT_WEBHOOK_MIN_SCORE)
        return aligned >= AUDFPRINT_EXTREME_HASHES ? 'borderline' : null
    for(const step of AUDFPRINT_LADDER){
        if(aligned >= step.hashes && consistencyPct >= step.score)
            return step.label
    }
    if(aligned >= AUDFPRINT_REVIEW_ALIGNED)
        return 'borderline' // log-only: review manually, no webhook
    return null
}

// Robustly pull "<name>.pklz" out of the worker's result key. The previous
// split(':').pop() broke on Windows drive letters ("C:\...") and any name
// containing a colon.
function extractPklzName(resultKey){
    const matches = String(resultKey).match(/[^:\\\/|]+\.pklz/gi)
    return matches ? matches[matches.length - 1] : 'unknown.pklz'
}

const HUMAN_LOG_LEGEND = [
    'LEGEND',
    '  Each entry is two lines:',
    '    [LABEL] <aligned> aligned / <raw> raw (<cons>%) | x<hits> | #<rank> | <source pklz> | offset <t>s',
    '    <matched file name> (<matched file path>)',
    '',
    '  aligned : time-consistent matching hashes - the primary evidence.',
    '            audfprint\'s docs: more than 5-6 aligned hashes usually means a true match.',
    '  raw     : all hashes the query and reference have in common, before time filtering.',
    '  cons%   : aligned / raw. Random chance stays under ~1%, so even a few percent is meaningful.',
    '  hits    : how many alignment hits the worker reported for this pair (the old "xN").',
    '  rank    : candidate position in audfprint\'s raw pre-ranking (diagnostic, not confidence).',
    '  offset  : query start relative to the reference, in seconds (negative = query starts earlier).',
    '  LABEL   : VERY STRONG / STRONG / PROBABLE are webhook-worthy; BORDERLINE = review manually;',
    '            NO MATCH = below every threshold, listed for completeness.',
    '',
    ''
].join('\n')

/* ---------------------------------------------------------------------------
 * Discord webhook rendering
 *
 * Results go into the message itself, inside a fenced code block, instead of
 * arriving as a .txt attachment nobody opens. The fence keeps the columns
 * lined up - Discord renders the body in a monospace font and leaves the
 * markdown in file names and titles alone.
 * ------------------------------------------------------------------------ */

// Discord rejects a message whose content runs past 2000 characters.
const DISCORD_CONTENT_LIMIT = 2000
const FENCE = '```'

function fenceSafe(text){
    // A run of three backticks in the body would close the fence early and
    // spill the rest of the report out as prose. A zero-width space between
    // them looks identical and cannot terminate anything. It goes after every
    // backtick that starts a run of three, so longer runs ("````") are broken
    // up too; exactly three come out as before.
    return String(text).replace(/`(?=``)/g, '`​')
}

// Builds "header + fenced body", trimmed to fit. Returns whether it had to cut
// anything, so the caller can attach the full text rather than lose the tail.
function codeBlockMessage(header, body){
    // Measured as it will be sent: postWebhook() puts an invisible zero-width
    // space after the "@" of every mention (@everyone, @here, <@123>) so a file
    // name cannot ping the server, and each one makes the text a character
    // longer. Doing it here first keeps the message within the limit; doing it
    // twice changes nothing.
    header = neutraliseMentions(header)
    const overhead = `${header}\n${FENCE}\n\n${FENCE}`.length
    const room = DISCORD_CONTENT_LIMIT - overhead
    const lines = fenceSafe(neutraliseMentions(String(body))).trimEnd().split('\n')
    let text = lines.join('\n')
    let truncated = false
    if(text.length > room){
        truncated = true
        // Cut whole lines, not mid-character: half an entry is worse than an
        // honest count of what is missing.
        const kept = []
        let used = 0
        for(const line of lines){
            const notice = `\n... ${lines.length - kept.length} more line(s), full report attached`
            if(used + line.length + 1 + notice.length > room)
                break
            kept.push(line)
            used += line.length + 1
        }
        if(kept.length === 0){
            // One line longer than the whole budget - a minified JSON blob
            // does this. Cutting on a line boundary would leave the message
            // with no body at all, so this one gets cut mid-line instead.
            const notice = `\n... 1 line cut short, full report attached`
            kept.push(lines[0].slice(0, Math.max(0, room - notice.length)))
            text = `${kept[0]}${notice}`
        }
        else
            text = `${kept.join('\n')}\n... ${lines.length - kept.length} more line(s), full report attached`
    }
    return { content: `${header}\n${FENCE}\n${text}\n${FENCE}`, truncated }
}

// One way in for every post, so rate limiting, formatting and failure
// reporting cannot drift between the four modes.
async function sendMatchWebhook(env, mode, fileBasename, report, fullReportFile = null){
    const { content, truncated } = codeBlockMessage(`[${mode}]: ${fileBasename}`, report)
    await sleep(WEBHOOK_SLEEP)
    const sent = await postWebhook(env.WEBHOOK_URL, content,
        truncated ? fullReportFile : null)
    if(sent)
        success(`Possible match found during search against "${fileBasename}" with ${mode} mode. Discord webhook message has been sent`
            + (truncated ? ' (report too long for one message, full text attached)' : ''))
    else
        // postWebhook swallows its own errors and returns false, so the
        // try/catch this used to sit in never fired and a failed post was
        // reported as a success.
        warning(`Match found for "${fileBasename}" with ${mode} mode but the Discord webhook post failed`)
    return sent
}

// note: appended to the line, e.g. that part of the database was not searched.
async function sendNoMatchWebhook(env, mode, fileBasename, note = ''){
    await sleep(WEBHOOK_SLEEP)
    const sent = await postWebhook(env.WEBHOOK_URL,
        `[${mode}]: ${fileBasename} - no match found${note}`)
    if(!sent)
        warning(`Could not post the "no match" webhook for "${fileBasename}" (${mode} mode)`)
    return sent
}

// Single source of truth for how a match is rendered. The log file and the
// Discord webhook both use this, so their formatting can never drift apart.
// Two lines per entry, blank line between entries.
function formatMatchEntry(match){
    const label = (match.confidence || 'no match').toUpperCase()
    const header = `[${label}] ${match.aligned_hashes} aligned / ${match.raw_common_hashes} raw `
        + `(${match.consistency_pct.toFixed(2)}%) | x${match.hits} | #${match.rank} | `
        + `${match.source_pklz} | offset ${match.offset_s}s`
    return `${header}\n${match.matched_basename} (${match.matched_file})\n`
}

function buildMatchReport(matches){
    return matches.map(formatMatchEntry).join('\n')
}

// The candidate the end-of-run summary names: the most confident label first,
// then (matches being sorted that way) the most aligned hashes within it.
// matches[0] alone could be a 42-aligned / 0.06% non-match while a PROBABLE
// further down was the one posted.
const CONFIDENCE_ORDER = ['very strong', 'strong', 'probable', 'borderline']
function pickSummaryMatch(matches){
    for(const label of CONFIDENCE_ORDER){
        const found = matches.find(match => match.confidence === label)
        if(found)
            return found
    }
    return matches[0] || null
}

// unsearched: { failed, total } database files - a "no match" then says how much
// of the database it does not cover.
async function createAudfprintLogs(env, queryFiles = [], unsearched = { failed: 0, total: 0 }){
    const gapNote = unsearched.failed > 0
        ? ` (${unsearched.failed} of ${unsearched.total} database file(s) could not be searched)`
        : ''
    if(!existsSync(consts.RESULTS_FILE)){
        warning(`No ${Mode.AUDFPRINT} results file was produced - nothing to analyze`)
        return []
    }
    let results
    try {
        results = JSON.parse(readFileSync(consts.RESULTS_FILE, 'utf-8'))
    }
    catch(error){
        warning(`Could not parse the ${Mode.AUDFPRINT} results file: ${error.message}`)
        return []
    }

    const matchesByInput = {}
    for(const [resultKey, match] of Object.entries(results)){
        const inputBasename = trimExtension(basename(match.input_file))
        const aligned = Number(match.common_hashes) || 0
        const rawCommon = Number(match.total_hashes) || 0
        // NOTE on field names: audfprint reports "<aligned> of <raw> common
        // hashes". The worker stores aligned as common_hashes and raw as
        // total_hashes; the old "match_score" was therefore the consistency
        // fraction all along - it is now named as such.
        // Rounded to the two decimals it is printed with, so a label always
        // agrees with the percentage next to it. The previous release compared
        // the rounded figure too: 40 / 2001 = 1.999% prints, and counts, as 2.00%.
        const consistencyPct = rawCommon > 0 ? Number(((aligned / rawCommon) * 100).toFixed(2)) : 0
        if(!matchesByInput[inputBasename])
            matchesByInput[inputBasename] = []
        matchesByInput[inputBasename].push({
            query: inputBasename,
            matched_file: match.matched_file,
            matched_basename: basename(match.matched_file),
            aligned_hashes: aligned,
            raw_common_hashes: rawCommon,
            consistency_pct: consistencyPct,
            hits: match.counter,
            rank: parseNumericField(match.rank_position),
            offset_s: parseNumericField(match.match_time),
            source_pklz: extractPklzName(resultKey),
            confidence: classifyMatch(aligned, consistencyPct)
        })
    }

    const summary = []
    for(const [inputBasename, matches] of Object.entries(matchesByInput)){
        // Absolute aligned-hash count is the statistic audfprint's own docs
        // characterize, so it is the primary sort key.
        matches.sort((a, b) => b.aligned_hashes - a.aligned_hashes)

        // Human-readable log. Same legend + same entry formatting as the
        // webhook below - both go through formatMatchEntry().
        createResultsLog(inputBasename, Mode.AUDFPRINT, `${HUMAN_LOG_LEGEND}${buildMatchReport(matches)}`)

        summary.push({ query: inputBasename, best: pickSummaryMatch(matches) })

        const webhookMatches = matches.filter(match =>
            match.confidence !== null && match.confidence !== 'borderline')
        const basenameWithFormat = `${inputBasename}.mp3`
        if(webhookMatches.length > 0){
            const tempFile = join(consts.TEMP_FOLDER, `${inputBasename}.webhook.txt`)
            // The attachment keeps the legend and every entry, and is only
            // sent when the message had to be cut. The message itself carries
            // the entries alone: the legend is the same sixteen lines every
            // time and would crowd out the actual matches inside 2000
            // characters. It stays in the on-disk log either way.
            writeFileSync(tempFile, `${HUMAN_LOG_LEGEND}${buildMatchReport(webhookMatches)}`, 'utf-8')
            await sendMatchWebhook(env, Mode.AUDFPRINT, basenameWithFormat,
                buildMatchReport(webhookMatches), tempFile)
            unlinkSync(tempFile)
        }
        else {
            // Candidates came back, but none cleared the confidence bar.
            empty(`No match found during search against "${basenameWithFormat}" with ${Mode.AUDFPRINT} mode${gapNote}`)
            await sendNoMatchWebhook(env, Mode.AUDFPRINT, basenameWithFormat, gapNote)
        }
    }

    // Inputs audfprint returned nothing at all for never appear in the results
    // file, so they would otherwise go unreported in both directions.
    for(const afpt of queryFiles){
        const inputBasename = trimExtension(basename(afpt))
        if(matchesByInput[inputBasename])
            continue
        const basenameWithFormat = `${inputBasename}.mp3`
        empty(`No candidates returned for "${basenameWithFormat}" with ${Mode.AUDFPRINT} mode${gapNote}`)
        await sendNoMatchWebhook(env, Mode.AUDFPRINT, basenameWithFormat, gapNote)
    }
    return summary
}

// Shards audfprint.js could not search (corrupt/truncated .pklz, out of memory,
// deleted mid-run). The run still completes without them, so say so loudly:
// "no match" means less when part of the database was never looked at.
// Returns how many files could not be searched.
async function reportFailedShards(env, pklzCount){
    let lines = []
    try { lines = readFileSync(FAILED_PKLZS_FILE, 'utf-8').split('\n').filter(line => line.trim() !== '') }
    catch { return 0 }
    if(lines.length === 0)
        return 0
    warning(`${lines.length} of ${pklzCount} database file(s) could not be searched and were skipped:`)
    for(const line of lines.slice(0, 20)){
        const [path, reason] = line.split('\t')
        warning(`  ${path} - ${reason || 'unknown error'}`)
    }
    if(lines.length > 20)
        warning(`  ... and ${lines.length - 20} more (full list in ${FAILED_PKLZS_FILE})`)
    // An out-of-memory shard used to stop the whole run with this advice. The
    // run now carries on without it, so the advice has to come from here.
    const outOfMemory = lines.some(line => /MemoryError|Unable to allocate/i.test(line))
    if(outOfMemory)
        warning('Some of them ran out of memory: run again with fewer --threads (every thread holds one PKLZ file in memory)')
    const listing = lines.map(line => {
        const [path, reason] = line.split('\t')
        return `${basename(path)} - ${reason || 'unknown error'}`
    }).join('\n')
    const { content, truncated } = codeBlockMessage(
        `[${Mode.AUDFPRINT}]: ${lines.length} database file(s) could not be searched (${outOfMemory ? 'out of memory - try fewer --threads' : 'corrupt?'}) and were skipped`, listing)
    await sleep(WEBHOOK_SLEEP)
    if(!await postWebhook(env.WEBHOOK_URL, content, truncated ? FAILED_PKLZS_FILE : null))
        warning('Could not post the list of unsearchable database files to Discord')
    return lines.length
}

function printAudfprintSummary(summary){
    if(summary.length === 0)
        return
    info('---- audfprint summary (best candidate per query, by aligned hashes) ----')
    for(const { query, best } of summary){
        if(!best){
            empty(`"${query}": no candidates returned`)
            continue
        }
        const description = `${best.aligned_hashes} aligned (${best.consistency_pct.toFixed(2)}% consistent) -> ${best.matched_basename} [${best.source_pklz}]`
        if(best.confidence && best.confidence !== 'borderline')
            success(`"${query}": ${best.confidence.toUpperCase()} match - ${description}`)
        else if(best.confidence === 'borderline')
            warning(`"${query}": borderline - review manually - ${description}`)
        else
            empty(`"${query}": no confident match (top candidate: ${description})`)
    }
}

/* ---------------------------------------------------------------------------
 * Database consolidation (--merge)
 * ------------------------------------------------------------------------ */

// Resolves { ok, dropped } - dropped is the % of hashes the merged table lost
// to full buckets, from audfprint's own "Saved fprints ... (x% dropped)" line.
function runMergeShard(env, shardPath, listFile){
    return new Promise(resolve => {
        const { exe, preArgs } = splitCommand(env.PYTHON_COMMAND)
        const child = spawn(exe, [
            ...preArgs,
            consts.AUDFPRINT_PROGRAM,
            'newmerge',
            '--dbase', shardPath,
            '--list',
            listFile
        ], { windowsHide: true })
        const stderrTail = []
        let dropped = null
        readline.createInterface({ input: child.stdout }).on('line', line => {
            if(line.trim() === '')
                return
            info(`  ${line.trim()}`)
            const saved = line.match(/^Saved fprints .*\(([\d.]+)% dropped\)/)
            if(saved)
                dropped = parseFloat(saved[1])
        })
        readline.createInterface({ input: child.stderr }).on('line', line => {
            if(line.trim() === '')
                return
            stderrTail.push(line.trim())
            if(stderrTail.length > 20)
                stderrTail.shift()
        })
        child.on('error', error => {
            warning(`Failed to launch audfprint for this shard: ${error.message}`)
            resolve({ ok: false, dropped })
        })
        child.on('close', code => {
            if(code === 0)
                return resolve({ ok: true, dropped })
            warning(`Shard merge failed (exit code ${code}). This usually means the source PKLZ files were built with incompatible audfprint parameters (density/samplerate/hashbits) and cannot be merged together`)
            if(stderrTail.length > 0)
                warning(`Last audfprint output:\n${stderrTail.join('\n')}`)
            resolve({ ok: false, dropped })
        })
    })
}

async function mergeDatabase(env, folderArg, shardFilesArg, maxDroppedArg){
    const maxDropped = (!isNaN(maxDroppedArg) && maxDroppedArg >= 0) ? Number(maxDroppedArg) : DEFAULT_MERGE_MAX_DROPPED
    const folder = (folderArg || '').trim()
    const baseFolder = join(consts.DATABASE_FOLDER, folder)
    if(!existsSync(baseFolder))
        exit(`The specified folder "${folder}" does not exist inside "database/"`)
    // Exclude previous merge output so re-running does not double-count.
    const pklzFiles = fetchFingerprints(baseFolder).filter(path => !path.includes('__merged'))
    if(pklzFiles.length === 0)
        exit(`No PKLZ files found in "${baseFolder}" to merge`)
    const perShard = (!isNaN(shardFilesArg) && shardFilesArg > 0) ? Math.floor(shardFilesArg) : DEFAULT_MERGE_SHARD_FILES
    const mergedName = `${folder || 'all'}__merged`
    const outDir = join(consts.DATABASE_FOLDER, mergedName)
    if(!existsSync(outDir))
        mkdirSync(outDir, { recursive: true })

    info(`Merging ${pklzFiles.length} PKLZ file(s) into shards of up to ${perShard} source files each`)
    info('Why this helps: audfprint must fully load (gunzip + unpickle) every database file on every match run, so hundreds of small PKLZ files pay that cost hundreds of times. A few large shards pay it a few times')
    warning(`Every table has the same fixed capacity, and a full bucket drops hashes at random. A merged shard that loses more than ${maxDropped}% of its hashes is discarded and its sources are left as they are (--max-dropped to change). Files that already hold millions of hashes each gain nothing from merging: lower --shard-files or merge only folders of small files`)

    const startedAt = Date.now()
    let merged = 0
    let failed = 0
    let rejected = 0
    let shardIndex = 0
    for(let start = 0; start < pklzFiles.length; start += perShard){
        shardIndex += 1
        const shard = pklzFiles.slice(start, start + perShard)
        const shardName = `merged-${String(shardIndex).padStart(3, '0')}.pklz`
        const shardPath = join(outDir, shardName)
        const listFile = join(consts.TEMP_FOLDER, `merge-shard-${shardIndex}.txt`)
        writeFileSync(listFile, shard.join('\n'))
        info(`[shard ${shardIndex}/${Math.ceil(pklzFiles.length / perShard)}] merging ${shard.length} file(s) -> ${shardName}`)
        const { ok, dropped } = await runMergeShard(env, shardPath, listFile)
        if(!ok)
            failed += 1
        else if(dropped === null || dropped > maxDropped){
            // A lossy shard searches faster and finds less. Not worth keeping.
            rejected += 1
            try { unlinkSync(shardPath) } catch { /* best effort */ }
            warning(`[shard ${shardIndex}] discarded: it would drop ${dropped === null ? 'an unknown share' : `${dropped}%`} of its hashes (limit ${maxDropped}%)`)
        }
        else
            merged += 1
        try { unlinkSync(listFile) } catch { /* best effort */ }
    }

    info(`Merge finished in ${formatSeconds(Date.now() - startedAt)}: ${merged} shard(s) created${rejected > 0 ? `, ${rejected} discarded as too lossy` : ''}${failed > 0 ? `, ${failed} failed` : ''} in "database/${mergedName}"`)
    if(merged > 0){
        success(`Search the merged shards with: --${Mode.AUDFPRINT} --folder "${mergedName}"`)
        warning(`Whole-database searches skip "*__merged" folders, so they keep searching the originals. The merged copies only replace them when searched explicitly with --folder`)
    }
    if(failed > 0 || rejected > 0)
        warning('Failed or discarded shards were skipped; their source PKLZ files remain untouched and can still be searched unmerged')
}

/* ---------------------------------------------------------------------------
 * Other search modes
 * ------------------------------------------------------------------------ */

async function musicbrainz(env, file, extension, duration){
    const fileBasename = basename(file)
    try {
        // "--name=value", not "--name value": yargs takes a value that starts
        // with "-" for an option of its own, and YouTube ids can start with one
        // ("-m828BrXeSc - ...mp3" arrived as --file true and crashed the script).
        await runTool(env.NODE_COMMAND, [consts.FPCALC_SCRIPT, `--file=${file}`, `--extension=${extension}`])
        const { stdout } = await runTool(env.NODE_COMMAND, [consts.MUSICBRAINZ_SCRIPT, `--file=${basename(file)}`, `--duration=${duration}`])
        const outputLogs = stdout.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
        // Accumulate across output lines (the previous version overwrote the
        // array each iteration, silently keeping only the last line's data).
        const results = []
        for(const outputLog of outputLogs){
            if(outputLog.error)
                exit(`Detected an invalid AcoustID API key: ${outputLog.data}`)
            for(const result of outputLog.data){
                if(parseFloat(result.score) >= MUSICBRAINZ_MIN_SCORE)
                    results.push(`[${result.score}% | EXT-${result.extension} | DUR-${result.duration}]: ${consts.ACOUSTID_TRACK_ENDPOINT}/${result.trackId}`)
            }
        }
        if(results.length > 0){
            const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.MUSICBRAINZ, `${results.join('\n')}\n`)
            await sendMatchWebhook(env, Mode.MUSICBRAINZ, fileBasename, results.join('\n'), resultsFile)
        }
        else {
            empty(`No match found during search against "${fileBasename}" with ${Mode.MUSICBRAINZ} mode`)
            await sendNoMatchWebhook(env, Mode.MUSICBRAINZ, fileBasename)
        }
    }
    catch(error){
        warning(`Failed to run ${Mode.MUSICBRAINZ} search against "${fileBasename}": ${error.message}`)
    }
}

async function audiotag(env, file){
    const fileBasename = basename(file)
    try {
        const response = await searchWithAudiotag(env.AUDIOTAG_KEY, file)
        if(response.match){
            const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.AUDIOTAG, `${JSON.stringify(response.match)}\n`)
            // Pretty-printed for the message: one long JSON line is unreadable
            // in a code block, and the raw form is still what hits the log.
            await sendMatchWebhook(env, Mode.AUDIOTAG, fileBasename,
                JSON.stringify(response.match, null, 2), resultsFile)
        }
        else if(response.error)
            // A failed lookup is not the same as a clean "nothing matched", so
            // it does not get a no-match webhook.
            warning(`Failed to run ${Mode.AUDIOTAG} search against "${fileBasename}": ${response.error}`)
        else {
            empty(`No match found during search against "${fileBasename}" with ${Mode.AUDIOTAG} mode`)
            await sendNoMatchWebhook(env, Mode.AUDIOTAG, fileBasename)
        }
    }
    catch(error){
        warning(`Failed to run ${Mode.AUDIOTAG} search against "${fileBasename}": ${error.message}`)
    }
}

async function shazam(env, file){
    const fileBasename = basename(file)
    try {
        await sleep(SHAZAM_SLEEP)
        const { stdout } = await runTool(env.PYTHON_COMMAND, [consts.SHAZAM_SCRIPT, file])
        const result = stdout.trim()
        if(result !== ''){
            const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.SHAZAM, `${result}\n`)
            await sendMatchWebhook(env, Mode.SHAZAM, fileBasename, result, resultsFile)
        }
        else {
            empty(`No match found during search against "${fileBasename}" with ${Mode.SHAZAM} mode`)
            await sendNoMatchWebhook(env, Mode.SHAZAM, fileBasename)
        }
    }
    catch(error){
        warning(`Failed to run ${Mode.SHAZAM} search against "${fileBasename}": ${error.message}`)
    }
}

/* ---------------------------------------------------------------------------
 * Pre-flight: tools, memory, disk space
 * ------------------------------------------------------------------------ */

const gigabytes = bytes => (bytes / 2 ** 30).toFixed(1)

// The node, python and ffmpeg this run will really use (utils/toolchain.js),
// checked before any work is done. Stops with every problem listed when one
// that is needed is missing or too old; returns the probe for the recipe.
async function checkTools(env, needs){
    const result = await checkToolchain({
        node: splitCommand(env.NODE_COMMAND),
        python: splitCommand(env.PYTHON_COMMAND),
        ffmpeg: splitCommand(env.FFMPEG_COMMAND)
    }, needs)
    info(`Tools: ${describeToolchain(result)}`)
    for(const note of result.notes)
        warning(note)
    if(result.problems.length > 0)
        exit(`Cannot run with the tools found:\n${result.problems.map(problem => `  - ${problem}`).join('\n')}`)
    return result
}

// Each matching thread holds one database table, and while it loads one it
// needs about MATCHER_PEAK_BYTES. When memory is short, fewer threads: better
// than shards failing with MemoryError or Windows paging for hours.
function fitThreadsToMemory(threads){
    const free = freemem()
    const fits = Math.floor((free - MEMORY_HEADROOM_BYTES) / MATCHER_PEAK_BYTES)
    if(fits >= threads)
        return threads
    const reduced = Math.max(1, fits)
    warning(`Only ${gigabytes(free)} GB of memory is free and each thread needs up to ${gigabytes(MATCHER_PEAK_BYTES)} GB while it loads a database file, so ${reduced} thread(s) are used instead of ${threads}`)
    return reduced
}

// temp/ (match output, results), logs/ (the reports) and the fingerprint cache
// are all written to; a full drive loses the run's results at the very end.
function checkDiskSpace(){
    const drives = new Map()
    for(const folder of [consts.TEMP_FOLDER, consts.LOGS_FOLDER, CACHE_FOLDER, consts.PRECOMPUTED_FOLDER]){
        const drive = parse(resolve(folder)).root.toUpperCase()
        if(drives.has(drive))
            continue
        try {
            const { bavail, bsize } = statfsSync(folder)
            drives.set(drive, Number(bavail) * Number(bsize))
        }
        catch { drives.set(drive, null) }
    }
    for(const [drive, free] of drives){
        if(free !== null && free < DISK_WARN_BYTES)
            warning(`Only ${gigabytes(free)} GB is free on ${drive} - temp/, logs/ or the fingerprint cache may fail to save, and with them this run's results`)
    }
}

// Between a minute and a day (the worker enforces the same range: longer
// overflows Node's timers, which then fire at once).
function shardTimeoutSeconds(){
    const minutes = argv['shard-timeout']
    const chosen = (!isNaN(minutes) && minutes > 0) ? minutes : DEFAULT_SHARD_TIMEOUT
    return Math.round(60 * Math.min(Math.max(chosen, 1), 24 * 60))
}

/* ---------------------------------------------------------------------------
 * Resuming a stopped search
 *
 * The matching stage of a whole-database search takes hours. Before it starts,
 * temp/_run.json records the search (folder, shifts, each query fingerprint
 * with a hash of it, how many database files) and temp/_pklzs_all.txt the full
 * list of database files, while scripts/audfprint.js keeps temp/_checkpoint.json
 * with every file it has finished and the results so far. When the run is
 * stopped - a crash, a cancel, a watchdog - `--resume` searches only
 * the files not finished yet and then reports everything as a normal run
 * would. A normal start wipes temp/, so it always starts over.
 * ------------------------------------------------------------------------ */

const RUN_STATE_VERSION = 1

function hashFileSync(path){
    return crypto.createHash('sha1').update(readFileSync(path)).digest('hex')
}

function readJsonFile(path){
    try { return JSON.parse(readFileSync(path, 'utf-8')) }
    catch { return null }
}

function saveRunState(state){
    const partial = `${RUN_STATE_FILE}.partial`
    writeFileSync(partial, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(partial, RUN_STATE_FILE)
}

// Called before a normal start wipes temp/: says so when it held a search
// that never finished.
function noteUnfinishedSearch(){
    const state = readJsonFile(RUN_STATE_FILE)
    if(!state || state.finished)
        return
    const done = readJsonFile(CHECKPOINT_FILE)?.done?.length || 0
    info(`The previous search (started ${state.startedAt}) stopped after ${done} of ${state.total} database files; this run starts over (werzatsong.js --resume would have continued it)`)
}

// The matching stage and its reports; shared by normal runs and --resume.
// total: database files of the whole search; searching: how many this attempt
// searches (fewer when resuming).
async function runMatchingStage(env, { threads, queries, total, searching, resumeFrom = null }){
    const matchStartedAt = Date.now()
    await audfprint(env, threads, { timeoutSeconds: shardTimeoutSeconds(), resumeFrom })
    info(`Search completed with ${Mode.AUDFPRINT} mode in ${formatSeconds(Date.now() - matchStartedAt)} (${(searching / Math.max(1, (Date.now() - matchStartedAt) / 1000)).toFixed(2)} pklz/sec), now analyzing results... Please wait and do not close the program`)
    // Unsearched database files are reported first: a "no match found"
    // below means less when part of the database was never looked at.
    const failed = await reportFailedShards(env, total)
    const summary = await createAudfprintLogs(env, queries, { failed, total })
    printAudfprintSummary(summary)
    // Reported, so there is nothing left to resume.
    const state = readJsonFile(RUN_STATE_FILE)
    if(state)
        saveRunState({ ...state, finished: true, finishedAt: new Date().toLocaleString('sv-SE') })
}

async function resumeSearch(env){
    const state = readJsonFile(RUN_STATE_FILE)
    if(!state || state.version !== RUN_STATE_VERSION)
        exit('Nothing to resume: temp/ holds no stopped audfprint search. A run that stopped before its matching stage, or one that a newer run replaced, has to be started again')
    if(state.finished)
        exit(`Nothing to resume: the last search (started ${state.startedAt}) finished`)
    for(const name of ['folder', 'shifts', 'trim'].filter(option => argv[option] !== undefined))
        warning(`--${name} is ignored with --resume: the stopped search's own setting is used`)
    if(['audiotag', 'musicbrainz', 'shazam'].some(mode => argv[mode]))
        info('Only the audfprint search is resumed; the other modes had finished before it started')
    // The very fingerprints the stopped search used, unchanged.
    for(const query of state.queries){
        if(!existsSync(query.path) || hashFileSync(query.path) !== query.sha1)
            exit(`Cannot resume: the query fingerprint "${basename(query.path)}" is missing or has changed since the search started`)
    }
    let all
    try { all = readFileSync(ALL_PKLZS_FILE, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean) }
    catch { exit('Cannot resume: the stopped search\'s list of database files (temp/_pklzs_all.txt) is gone') }
    const checkpoint = existsSync(CHECKPOINT_FILE) ? readJsonFile(CHECKPOINT_FILE) : null
    if(existsSync(CHECKPOINT_FILE) && !checkpoint)
        exit('Cannot resume: temp/_checkpoint.json is unreadable')
    const done = new Set((checkpoint?.done || []).map(entry => entry.fingerprint))
    const remaining = all.filter(path => !done.has(path))
    info(`Resuming the search started ${state.startedAt} in "database/${state.folder}" (query --shifts ${state.shifts}): ${done.size} of ${all.length} database files were finished, ${remaining.length} left`)

    // What the files being matched at the stop left behind.
    for(const entry of readdirSync(consts.TEMP_FOLDER)){
        if(entry.endsWith('.match.txt') || entry.endsWith('.partial'))
            rmSync(join(consts.TEMP_FOLDER, entry), { force: true })
    }
    writeFileSync(consts.PKLZS_FILE, remaining.join('\n'))
    writeFileSync(consts.AFPTS_FILE, state.queries.map(query => query.path).join('\n'))

    await checkTools(env, { workerNode: true, python: true, pythonModules: true, decoder: false, trimmer: false })
    let threads = Math.min(consts.MAX_CORES_ALLOWED, (!isNaN(argv.threads) && argv.threads > 0) ? argv.threads : availableParallelism())
    threads = fitThreadsToMemory(threads)
    checkDiskSpace()
    info(`Using ${threads} concurrent threads for processing`)
    await runMatchingStage(env, {
        threads,
        queries: state.queries.map(query => query.path),
        total: all.length,
        searching: remaining.length,
        resumeFrom: checkpoint ? CHECKPOINT_FILE : null
    })
}

function reportWhereResultsAre(){
    if(existsSync(RESULTS_FOLDER) && readdirSync(RESULTS_FOLDER).some(file => extname(file) === '.txt'))
        info(`Execution complete! Check logs results in: ${RESULTS_FOLDER}`)
    else
        info('Execution complete! Unfortunately, no results were found')
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

async function init(){
    let { duration, extension, folder, merge, shifts, threads, trim } = argv
    const resuming = Boolean(argv.resume) && merge === undefined
    info(`Welcome to WerZatSong ${PROGRAM_VERSION}! - Developed by Nel with contributions from Numerophobe, AzureBlast and Mystic65`)
    // Before anything touches temp/, precomputed/ or processed/: setupFolders()
    // wipes them, which destroys a run already in progress.
    const lock = runLock.acquire(merge !== undefined ? 'werzatsong.js --merge' : (resuming ? 'werzatsong.js --resume' : 'werzatsong.js'))
    if(!lock.acquired){
        console.error(`[BUSY]: ${runLock.describe(lock.holder)} is already using this WerZatSong install. Try again when it has finished.`)
        process.exit(BUSY_EXIT_CODE)
    }
    process.on('exit', lock.release)
    if(lock.inherited)
        info('Running under the run lock held by the launcher')
    if(!resuming && merge === undefined)
        noteUnfinishedSearch()
    setupFolders({ keepSearchState: resuming })
    const env = fetchEnvironment()

    // Standalone database-maintenance mode: merge and exit. Runs before any
    // webhook/API validation because none of that is needed for merging.
    if(merge !== undefined){
        await mergeDatabase(env, merge, argv['shard-files'], argv['max-dropped'])
        return
    }

    const validatedWebhook = await validateWebhook(env.WEBHOOK_URL)
    if(validatedWebhook){
        env.WEBHOOK_URL = validatedWebhook
        success('Discord webhook has been set successfully in .env file')
    }
    if(resuming){
        await resumeSearch(env)
        reportWhereResultsAre()
        return
    }
    const modes = parseModes()
    if(modes.includes(Mode.AUDIOTAG)){
        const validatedAudiotag = await validateAudiotag(env.AUDIOTAG_KEY)
        if(validatedAudiotag){
            env.AUDIOTAG_KEY = validatedAudiotag
            success('Audiotag API key has been set successfully in .env file')
        }
    }
    if(modes.includes(Mode.MUSICBRAINZ)){
        const validatedMusicbrainz = await validateMusicbrainz(env.ACOUSTID_KEY)
        if(validatedMusicbrainz){
            env.ACOUSTID_KEY = validatedMusicbrainz
            success('AcoustID API key has been set successfully in .env file')
        }
        extension = validateExtension(extension)
        duration = validateDuration(duration)
    }

    // Query-side shifts: robustness vs. speed knob, see file header.
    shifts = (!isNaN(shifts) && shifts >= 1 && shifts <= 8) ? Math.floor(shifts) : DEFAULT_QUERY_SHIFTS

    let pklzCount = 0
    if(modes.includes(Mode.AUDFPRINT)){
        threads = Math.min(consts.MAX_CORES_ALLOWED, (!isNaN(threads) && threads > 0) ? threads : availableParallelism())
		// threads = 40
        pklzCount = setupAudfprint(folder)
        // This used to recommend --merge unconditionally. Most PKLZ files here
        // already hold 7-10 million hashes and drop ~1% of them to full buckets
        // on their own; merging 64 of them into one table of the same size would
        // throw most hashes away. --merge now refuses shards that lose too much.
        if(pklzCount > 50)
            info(`Searching ${pklzCount} separate PKLZ files; each is loaded once per run. --merge can combine small ones (it skips shards that would drop more than ${DEFAULT_MERGE_MAX_DROPPED}% of their hashes)`)
    }

    const { audioFiles, precomputedFiles } = loadSamples(modes)
    const trimming = !isNaN(Number(trim)) && trim > 0
    const audfprintMode = modes.includes(Mode.AUDFPRINT)
    const tools = await checkTools(env, {
        workerNode: audfprintMode || modes.includes(Mode.MUSICBRAINZ),
        python: audfprintMode || modes.includes(Mode.SHAZAM),
        pythonModules: audfprintMode,
        decoder: audfprintMode && audioFiles.length > 0,
        trimmer: trimming && audioFiles.length > 0
    })
    const recipe = fingerprintRecipe(tools, dirname(consts.AUDFPRINT_PROGRAM), trimming)
    if(audfprintMode)
        threads = fitThreadsToMemory(threads)
    checkDiskSpace()
    const prepStartedAt = Date.now()
    const { afpts, mp3s } = await generateFiles(env, trim, shifts, modes, audioFiles, precomputedFiles, recipe)
    if(audioFiles.length > 0)
        info(`Input preparation took ${formatSeconds(Date.now() - prepStartedAt)}`)

    if(modes.some(mode => mode !== Mode.AUDFPRINT)){
        const mp3Modes = modes.filter(mode => mode !== Mode.AUDFPRINT)
        info(`Searching ${mp3s.length} MP3 files with mode${mp3Modes.length > 1 ? 's' : ''}: ${mp3Modes.join(', ')}`)
        if(trim > 0)
            info(`MP3 files will be shortened to ${trim} seconds for all search modes`)
        if(modes.includes(Mode.MUSICBRAINZ)){
            const [minDuration, maxDuration] = duration.split(':').map(Number)
            info(`Mode ${Mode.MUSICBRAINZ} will be searching for tracks with duration ranges between ${minDuration} and ${maxDuration} seconds`)
            info(`Mode ${Mode.MUSICBRAINZ} will be extending tracks between 0 and ${extension} seconds during the searches`)
        }
        for(const mp3 of mp3s){
            const basenameMp3 = basename(mp3)
            if(modes.includes(Mode.MUSICBRAINZ)){
                info(`Searching "${basenameMp3}" with ${Mode.MUSICBRAINZ} mode`)
                await musicbrainz(env, mp3, extension, duration)
            }
            if(modes.includes(Mode.AUDIOTAG)){
                info(`Searching "${basenameMp3}" with ${Mode.AUDIOTAG} mode`)
                await audiotag(env, mp3)
            }
            if(modes.includes(Mode.SHAZAM)){
                info(`Searching "${basenameMp3}" with ${Mode.SHAZAM} mode`)
                await shazam(env, mp3)
            }
        }
    }

    if(modes.includes(Mode.AUDFPRINT)){
        if(afpts.length === 0)
            exit(`In ${Mode.AUDFPRINT} mode, at least one valid precomputed AFPT file is required`)
        writeFileSync(consts.AFPTS_FILE, afpts.join('\n'))
        info(`Searching ${afpts.length} precomputed audio files with ${Mode.AUDFPRINT} mode (query --shifts ${shifts})`)
        info(`Loaded a total of ${pklzCount} PKLZ files from the folder "database/${folder || ''}"`)
        info(`Using ${threads} concurrent threads for processing`)
        // Note: parallelism lives in the worker (one process per thread). If
        // you also raise audfprint's own --ncores inside the worker you will
        // run threads x ncores processes and thrash CPU/RAM - keep one level.
        // What --resume needs if this search is stopped part-way.
        copyFileSync(consts.PKLZS_FILE, ALL_PKLZS_FILE)
        saveRunState({
            version: RUN_STATE_VERSION,
            startedAt: new Date().toLocaleString('sv-SE'),
            folder: folder ? folder.trim() : '',
            shifts,
            total: pklzCount,
            queries: afpts.map(path => ({ path, sha1: hashFileSync(path) })),
            finished: false
        })
        await runMatchingStage(env, { threads, queries: afpts, total: pklzCount, searching: pklzCount })
    }

    reportWhereResultsAre()
}

init().catch(error => {
    // Without this an unexpected throw is an unhandled rejection: Node prints a
    // bare stack and exits, and nothing says which phase failed.
    console.error(`[ERROR]: WerZatSong stopped unexpectedly: ${error?.stack || error}`)
    process.exit(1)
})