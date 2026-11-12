/*
 * Which node, python and ffmpeg a WerZatSong run really uses, whether they are
 * recent enough, and a short "recipe" tag for everything that shapes a query
 * fingerprint, so a cached fingerprint is not reused after one of them changed.
 *
 * Two ffmpegs can be involved, and they need not be the same program:
 *   - the decoder: audfprint turns audio into samples with whatever "ffmpeg"
 *     Python finds (libs/audfprint/audio_read.py runs ['ffmpeg', ...]; it never
 *     sees FFMPEG_COMMAND). So it is probed from inside Python, the same way;
 *   - the trimmer: --trim re-encodes the input with FFMPEG_COMMAND from .env.
 * The node that runs the worker is NODE_COMMAND, which can differ from the
 * node running werzatsong.js itself, so both are checked.
 *
 * Node's version does not change a fingerprint and is not part of the recipe;
 * python, numpy, scipy, the decoder (and the trimmer when trimming) and the
 * fingerprinting code itself are.
 */

const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')

const execFileP = promisify(execFile)

const MIN_NODE = [18, 15, 0]    // os.availableParallelism() needs 18.14, fs.statfsSync() 18.15
const MIN_PYTHON = [3, 8, 0]
// What audfprint.py imports at start-up; any one missing and nothing is matched.
const PYTHON_MODULES = ['numpy', 'scipy', 'docopt', 'psutil', 'joblib']
// The code that turns audio into a query fingerprint: audfprint.py (option
// defaults such as --density, and precompute itself), the analyzer, the
// decoder wrapper and the spectrogram.
const FINGERPRINT_CODE = ['audfprint.py', 'audfprint_analyze.py', 'audio_read.py', 'stft.py']
const RECIPE_VERSION = 1
const PROBE_TIMEOUT_MS = 120_000

const PYTHON_PROBE = `
import json, shutil, subprocess, sys
info = {"version": sys.version.split()[0], "executable": sys.executable, "modules": {}, "missing": []}
for name in ${JSON.stringify(PYTHON_MODULES)}:
    try:
        module = __import__(name)
        info["modules"][name] = str(getattr(module, "__version__", "unknown"))
    except Exception as error:
        info["missing"].append("%s (%s)" % (name, type(error).__name__))
decoder = {"path": shutil.which("ffmpeg"), "version": None}
try:
    done = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=60)
    lines = done.stdout.decode("utf-8", "replace").splitlines()
    if done.returncode == 0 and lines:
        decoder["version"] = lines[0].strip()
    else:
        decoder["error"] = "exit code %d" % done.returncode
except Exception as error:
    decoder["error"] = "%s: %s" % (type(error).__name__, error)
info["decoder"] = decoder
sys.stdout.write(json.dumps(info))
`

function parseVersion(text){
    const found = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
    return found ? [Number(found[1]), Number(found[2]), Number(found[3] || 0)] : null
}

function atLeast(version, minimum){
    for(let i = 0; i < 3; i++){
        if(version[i] !== minimum[i])
            return version[i] > minimum[i]
    }
    return true
}

const showVersion = version => version.join('.')

async function run({ exe, preArgs }, args){
    const { stdout } = await execFileP(exe, [...preArgs, ...args], {
        encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    })
    return stdout
}

const firstLine = text => String(text || '').split(/\r?\n/)[0].trim()

/*
 * commands: { node, python, ffmpeg } as { exe, preArgs } (werzatsong.js's
 * splitCommand of NODE_COMMAND, PYTHON_COMMAND, FFMPEG_COMMAND).
 * needs: { workerNode, python, pythonModules, decoder, trimmer } - which of
 * them this run cannot do without. Anything missing that is not needed is
 * only noted.
 */
async function checkToolchain(commands, needs){
    const result = { problems: [], notes: [], node: process.version, workerNode: null, python: null, decoder: null, trimmer: null }
    const report = (needed, text) => (needed ? result.problems : result.notes).push(text)

    const running = parseVersion(process.version)
    if(!running || !atLeast(running, MIN_NODE))
        result.problems.push(`node ${process.version} runs werzatsong.js, but ${showVersion(MIN_NODE)} or newer is needed`)

    try {
        const version = firstLine(await run(commands.node, ['--version']))
        result.workerNode = version
        const parsed = parseVersion(version)
        if(!parsed || !atLeast(parsed, MIN_NODE))
            report(needs.workerNode, `NODE_COMMAND is node ${version || '(unknown version)'}, but ${showVersion(MIN_NODE)} or newer is needed`)
    }
    catch(error){
        report(needs.workerNode, `NODE_COMMAND (${commands.node.exe}) cannot be run: ${error.message.split('\n')[0]}`)
    }

    if(needs.python || needs.pythonModules || needs.decoder){
        try {
            const info = JSON.parse(await run(commands.python, ['-c', PYTHON_PROBE]))
            result.python = info
            result.decoder = info.decoder
            const parsed = parseVersion(info.version)
            if(!parsed || !atLeast(parsed, MIN_PYTHON))
                report(needs.python, `PYTHON_COMMAND is Python ${info.version}, but ${showVersion(MIN_PYTHON)} or newer is needed`)
            if(info.missing.length > 0)
                report(needs.pythonModules, `Python (${info.executable}) cannot import ${info.missing.join(', ')} - install with: python -m pip install -r requirements.txt`)
            if(!info.decoder.version)
                report(needs.decoder, `audfprint decodes audio with the "ffmpeg" Python finds, and there is none that runs${info.decoder.path ? ` (${info.decoder.path}: ${info.decoder.error})` : ' on its PATH'}`)
        }
        catch(error){
            report(needs.python || needs.pythonModules, `PYTHON_COMMAND (${commands.python.exe}) cannot be run: ${error.message.split('\n')[0]}`)
        }
    }

    if(needs.trimmer){
        try {
            result.trimmer = firstLine(await run(commands.ffmpeg, ['-version']))
        }
        catch(error){
            result.problems.push(`--trim needs FFMPEG_COMMAND (${commands.ffmpeg.exe}), which cannot be run: ${error.message.split('\n')[0]}`)
        }
        if(result.trimmer && result.decoder?.version && result.trimmer !== result.decoder.version)
            result.notes.push(`--trim uses a different ffmpeg (${result.trimmer}) than audfprint's decoder (${result.decoder.version})`)
    }
    return result
}

function describeToolchain(result){
    const parts = [`node ${result.node}`]
    if(result.workerNode && result.workerNode !== result.node)
        parts.push(`worker node ${result.workerNode}`)
    if(result.python){
        const modules = ['numpy', 'scipy'].filter(name => result.python.modules[name]).map(name => `${name} ${result.python.modules[name]}`)
        parts.push(`python ${result.python.version}${modules.length ? ` (${modules.join(', ')})` : ''}`)
    }
    if(result.decoder?.version)
        parts.push(`decoder ${result.decoder.version.replace(/ Copyright.*$/, '')}${result.decoder.path ? ` [${result.decoder.path}]` : ''}`)
    if(result.trimmer)
        parts.push(`trimmer ${result.trimmer.replace(/ Copyright.*$/, '')}`)
    return parts.join(' | ')
}

// Short tag for everything that shapes a query fingerprint besides the input
// itself, --trim and --shifts (those are in the cache key already).
function fingerprintRecipe(result, audfprintDir, trimming){
    const code = {}
    for(const name of FINGERPRINT_CODE){
        try { code[name] = crypto.createHash('sha1').update(readFileSync(join(audfprintDir, name))).digest('hex') }
        catch { code[name] = 'unreadable' }
    }
    const recipe = {
        recipe: RECIPE_VERSION,
        python: result.python?.version || null,
        numpy: result.python?.modules?.numpy || null,
        scipy: result.python?.modules?.scipy || null,
        decoder: result.decoder?.version || null,
        trimmer: trimming ? (result.trimmer || null) : null,
        code
    }
    return crypto.createHash('sha1').update(JSON.stringify(recipe)).digest('hex').slice(0, 10)
}

module.exports = { MIN_NODE, MIN_PYTHON, checkToolchain, describeToolchain, fingerprintRecipe }
