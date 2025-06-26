const dotenv = require('dotenv')
const { exec, spawn } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require('node:fs')
const { availableParallelism } = require('node:os')
const { basename, extname, join } = require('node:path')
const { promisify } = require('node:util')
const { hideBin } = require('yargs/helpers')
const yargs = require('yargs/yargs')
const { searchWithAudiotag } = require('./scripts/audiotag')
const consts = require('./utils/consts')
const { generateUnique, sleep, trimExtension } = require('./utils/helpers')
const { empty, exit, info, success, warning } = require('./utils/messages')
const { validateAudiotag, validateDuration, validateExtension, validateMusicbrainz, validateWebhook } = require('./utils/validators')
const postWebhook = require('./utils/webhook')

require('node:events').setMaxListeners(100) // increase listeners limit

const AUDFPRINT_LOWEST_HASHES = 25 // amount
const AUDFPRINT_LOWEST_SCORE = 7 // percentage
const AUDFPRINT_HIGHEST_HASHES = 40 // amount
const AUDFPRINT_HIGHEST_SCORE = 2 // percentage
const AUDFPRINT_EXTREME_HASHES = 70 // amount
const MAX_FILES_PER_SEARCH = 30 // amount
const MUSICBRAINZ_MIN_SCORE = 60 // percentage
const PROGRAM_VERSION = 'v1.0.0'
const RESULTS_FOLDER = join(consts.LOGS_FOLDER, generateUnique())
const SHAZAM_SLEEP = 1.5 // seconds
const WEBHOOK_SLEEP = 2 // seconds

const Mode = {
    AUDFPRINT: 'audfprint',
    AUDIOTAG: 'audiotag',
    MUSICBRAINZ: 'musicbrainz',
    SHAZAM: 'shazam'
}

const execPromise = promisify(exec)
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

function setupFolders(){
    const foldersToClean = [
        consts.PRECOMPUTED_FOLDER,
        consts.PROCESSED_FOLDER,
        consts.TEMP_FOLDER
    ]
    for(const folder of foldersToClean){
        if(existsSync(folder))
            rmSync(folder, { recursive: true })
        mkdirSync(folder)
    }
    const foldersToCreate = [
        ...foldersToClean,
        consts.DATABASE_FOLDER,
        consts.INPUT_FOLDER,
        consts.LOGS_FOLDER
    ]
    for(const folder of foldersToCreate){
        if(!existsSync(folder))
            mkdirSync(folder)
    }
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
    const audioFiles = readdirSync(consts.INPUT_FOLDER).filter(filename => filename.endsWith('.mp3'))
    const precomputedFiles = readdirSync(consts.INPUT_FOLDER).filter(filename => filename.endsWith('.afpt'))
    if(modes.some(mode => mode !== Mode.AUDFPRINT) && audioFiles.length === 0)
        exit(`You need at least one MP3 file in the "input" folder if you included mode: ${Mode.AUDIOTAG}, ${Mode.MUSICBRAINZ} or ${Mode.SHAZAM}`)
    if(audioFiles.length > MAX_FILES_PER_SEARCH)
        exit(`Too many MP3 files! Limit per each search is ${MAX_FILES_PER_SEARCH} files, but found ${audioFiles.length} files (MP3)`)
    if(modes.includes(Mode.AUDFPRINT) && audioFiles.length === 0 && precomputedFiles.length === 0)
        exit(`In ${Mode.AUDFPRINT} mode, add at least one MP3 or AFPT file to "input" folder`)
    const mp3Basenames = audioFiles.map(file => trimExtension(file))
    const afptBasenames = precomputedFiles.map(file => trimExtension(file))
    const collisions = mp3Basenames.filter(base => afptBasenames.includes(base))
    if(collisions.length > 0){
        const collisionFiles = collisions.map(base => `- ${base}.mp3 / ${base}.afpt\n`).join('')
        exit(`Duplicated filename collisions detected in "input" folder:\n${collisionFiles}`)
    }
    const totalFiles = audioFiles.length + precomputedFiles.length
    if(modes.includes(Mode.AUDFPRINT) && totalFiles > MAX_FILES_PER_SEARCH)
        exit(`Too many files! Limit per each ${Mode.AUDFPRINT} search is ${MAX_FILES_PER_SEARCH} files, but found ${totalFiles} files (MP3 + AFPT)`)
    return { audioFiles, precomputedFiles }
}

async function trimFile(ffmpegCommand, filename, seconds){
    try {
        const originalPath = join(consts.INPUT_FOLDER, filename)
        const trimmedPath = join(consts.PROCESSED_FOLDER, filename)
        await execPromise(`${ffmpegCommand} -i "${originalPath}" -y -t ${seconds} "${trimmedPath}"`)
    }
    catch(error){
        exit(`Failed to trim "${filename}": ${error.message}`)
    }
}

async function precomputeFile(pythonCommand, filename){
    try {
        const { stdout } = await execPromise(`${pythonCommand} "${consts.AUDFPRINT_PROGRAM}" precompute --precompdir "${consts.PRECOMPUTED_FOLDER}" --shifts 4 "${join(consts.INPUT_FOLDER, filename)}"`)
        if(stdout.includes('Zero length analysis')){
            warning(`File "${filename}" is too short to be precomputed, will be skipped in ${Mode.AUDFPRINT} mode`)
            return null
        }
        return `${trimExtension(filename)}.afpt`
    }
    catch(error){
        exit(`Failed to precompute "${filename}": ${error.message}`)
    }
}

async function generateFiles(env, trimSeconds, modes, audioFiles, precomputedFiles){
    const filesToProcess = { afpts: [], mp3s: [] }
    if(audioFiles?.length > 0){
        for(const audioFile of audioFiles){
            if(isNaN(Number(trimSeconds)) || trimSeconds <= 0)
                copyFileSync(join(consts.INPUT_FOLDER, audioFile), join(consts.PROCESSED_FOLDER, audioFile))
            else
                await trimFile(env.FFMPEG_COMMAND, audioFile, trimSeconds)
            filesToProcess.mp3s.push(join(consts.PROCESSED_FOLDER, audioFile))
            if(modes.includes(Mode.AUDFPRINT)){
                const precomputedFile = await precomputeFile(env.PYTHON_COMMAND, audioFile)
                if(precomputedFile)
                    filesToProcess.afpts.push(join(consts.PRECOMPUTED_FOLDER, precomputedFile))
            }
        }
    }
    if(modes.includes(Mode.AUDFPRINT) && precomputedFiles?.length > 0){
        for(const precomputedFile of precomputedFiles){
            copyFileSync(join(consts.INPUT_FOLDER, precomputedFile), join(consts.PRECOMPUTED_FOLDER, precomputedFile))
            filesToProcess.afpts.push(join(consts.PRECOMPUTED_FOLDER, precomputedFile))
        }
    }
    return filesToProcess
}

function createResultsLog(basename, mode, content){
    if(!existsSync(RESULTS_FOLDER))
        mkdirSync(RESULTS_FOLDER)
    const resultsFile = join(RESULTS_FOLDER, `${basename}.${mode}.txt`)
    writeFileSync(resultsFile, content)
    return resultsFile
}

function fetchFingerprints(targetFolder){
    let pklzFiles = []
    const fetchFilesRecursively = dir => {
        const files = readdirSync(dir, { withFileTypes: true })
        for(const file of files){
            const fullPath = join(dir, file.name)
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
    const pklzFiles = fetchFingerprints(baseFolder)
    if(pklzFiles.length === 0)
        exit(`No PKLZ files found in "${baseFolder}"`)
    writeFileSync(consts.PKLZS_FILE, pklzFiles.join('\n'))
}

function audfprint(env, threads){
    return new Promise((resolve, reject) => {
        const audfprintProcess = spawn(env.NODE_COMMAND, [consts.AUDFPRINT_SCRIPT, '--threads', threads])
        audfprintProcess.stdout.on('data', data => {
            info(data.toString().trim())
        })
        audfprintProcess.stderr.on('data', data => {
            const errorMessage = data.toString().trim()
            exit(errorMessage.includes('MemoryError') ? 'The process ran out of memory. Please try reducing the number of threads and run it again' : errorMessage)
        })
        audfprintProcess.on('close', code => {
            if(code === 0)
                resolve()
            else {
                warning(`Mode ${Mode.AUDFPRINT} exited with error code: ${code}`)
                reject()
            }
        })
    })
}

async function createAudfprintLogs(env){
    const results = JSON.parse(readFileSync(consts.RESULTS_FILE, 'utf-8'))
    const matchesByAfpt = {}
    for(const [, match] of Object.entries(results)){
        const inputBasename = trimExtension(basename(match.input_file))
        if(!matchesByAfpt[inputBasename])
            matchesByAfpt[inputBasename] = []
        matchesByAfpt[inputBasename].push({
            matched_file: match.matched_file,
            matched_file_basename: basename(match.matched_file),
            match_score: ((match.common_hashes / match.total_hashes) * 100).toFixed(2),
            common_hashes: match.common_hashes,
            total_hashes: match.total_hashes,
            match_time: match.match_time,
            rank_position: match.rank_position,
            counter: match.counter
        })
    }
    for(const [inputBasename, matches] of Object.entries(matchesByAfpt)){
        matches.sort((a, b) => b.common_hashes - a.common_hashes)
        let logContent = ''
        for(const match of matches)
            logContent += `[${match.common_hashes}/${match.total_hashes} | ${match.match_score}% | x${match.counter} | ${match.rank_position} | ${match.match_time}]: ${match.matched_file_basename} (${match.matched_file})\n\n`
        createResultsLog(inputBasename, Mode.AUDFPRINT, logContent)
        const possibleMatches = matches.filter(match => (match.match_score >= AUDFPRINT_LOWEST_SCORE && match.common_hashes >= AUDFPRINT_LOWEST_HASHES) || (match.match_score >= AUDFPRINT_HIGHEST_SCORE && match.common_hashes >= AUDFPRINT_HIGHEST_HASHES) || (match.common_hashes >= AUDFPRINT_EXTREME_HASHES))
        if(possibleMatches.length > 0){
            const tempFile = join(consts.TEMP_FOLDER, `${inputBasename}.webhook.txt`)
            let webhookContent = ''
            for(const match of possibleMatches)
                webhookContent += `[${match.common_hashes}/${match.total_hashes} | ${match.match_score}% | x${match.counter} | ${match.rank_position} | ${match.match_time}]: ${match.matched_file_basename}\n\n`
            writeFileSync(tempFile, webhookContent, 'utf-8')
            const basenameWithFormat = `${inputBasename}.mp3`
            await sleep(WEBHOOK_SLEEP)
            await postWebhook(env.WEBHOOK_URL, `[${Mode.AUDFPRINT}]: ${basenameWithFormat}`, tempFile)
            unlinkSync(tempFile)
            success(`Possible match found during search against "${basenameWithFormat}" with ${Mode.AUDFPRINT} mode. Discord webhook message has been sent`)
        }
    }
}

async function musicbrainz(env, file, extension, duration){
    const fileBasename = basename(file)
    try {
        await execPromise(`${env.NODE_COMMAND} "${consts.FPCALC_SCRIPT}" --file "${file}" --extension ${extension}`)
        const { stdout } = await execPromise(`${env.NODE_COMMAND} "${consts.MUSICBRAINZ_SCRIPT}" --file "${basename(file)}" --duration "${duration}"`)
        const outputLogs = stdout.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
        let results = []
        for(const outputLog of outputLogs){
            if(outputLog.error)
                exit(`Detected an invalid AcoustID API key: ${outputLog.data}`)
            results = outputLog.data.filter(result => parseFloat(result.score) >= MUSICBRAINZ_MIN_SCORE).map(result => {
                return `[${result.score}% | EXT-${result.extension} | DUR-${result.duration}]: ${consts.ACOUSTID_TRACK_ENDPOINT}/${result.trackId}`
            })
        }
        if(results.length > 0){
            const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.MUSICBRAINZ, `${results.join('\n')}\n`)
            await postWebhook(env.WEBHOOK_URL, `[${Mode.MUSICBRAINZ}]: ${fileBasename}`, resultsFile)
            success(`Possible match found during search against "${fileBasename}" with ${Mode.MUSICBRAINZ} mode. Discord webhook message has been sent`)
        }
        else
            empty(`No match found during search against "${fileBasename}" with ${Mode.MUSICBRAINZ} mode`)
    }
    catch(error){
        warning(`Failed to run ${Mode.MUSICBRAINZ} search against "${fileBasename}": ${error.message}`)
    }
}

async function audiotag(env, file){
    const fileBasename = basename(file)
    const response = await searchWithAudiotag(env.AUDIOTAG_KEY, file)
    if(response.match){
        const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.AUDIOTAG, `${JSON.stringify(response.match)}\n`)
        await postWebhook(env.WEBHOOK_URL, `[${Mode.AUDIOTAG}]: ${fileBasename}`, resultsFile)
        success(`Possible match found during search against "${fileBasename}" with ${Mode.AUDIOTAG} mode. Discord webhook message has been sent`)
    }
    else if(response.error)
        warning(`Failed to run ${Mode.AUDIOTAG} search against "${fileBasename}": ${response.error}`)
    else
        empty(`No match found during search against "${fileBasename}" with ${Mode.AUDIOTAG} mode`)
}

async function shazam(env, file){
    const fileBasename = basename(file)
    try {
        await sleep(SHAZAM_SLEEP)
        const { stdout } = await execPromise(`${env.PYTHON_COMMAND} "${consts.SHAZAM_SCRIPT}" "${file}"`)
        const result = stdout.trim()
        if(result !== ''){
            const resultsFile = createResultsLog(trimExtension(fileBasename), Mode.SHAZAM, `${result}\n`)
            await postWebhook(env.WEBHOOK_URL, `[${Mode.SHAZAM}]: ${fileBasename}`, resultsFile)
            success(`Possible match found during search against "${fileBasename}" with ${Mode.SHAZAM} mode. Discord webhook message has been sent`)
        }
        else
            empty(`No match found during search against "${fileBasename}" with ${Mode.SHAZAM} mode`)
    }
    catch(error){
        warning(`Failed to run ${Mode.SHAZAM} search against "${fileBasename}": ${error.message}`)
    }
}

async function init(){
    let { duration, extension, folder, threads, trim } = argv
    info(`Welcome to WerZatSong ${PROGRAM_VERSION}! - Developed by Nel with contributions from Numerophobe, AzureBlast and Mystic65`)
    setupFolders()
    const env = fetchEnvironment()
    const validatedWebhook = await validateWebhook(env.WEBHOOK_URL)
    if(validatedWebhook){
        env.WEBHOOK_URL = validatedWebhook
        success('Discord webhook has been set successfully in .env file')
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
    if(modes.includes(Mode.AUDFPRINT)){
        threads = Math.min(consts.MAX_CORES_ALLOWED, (!isNaN(threads) && threads > 0) ? threads : availableParallelism())
        setupAudfprint(folder)
    }
    const { audioFiles, precomputedFiles } = loadSamples(modes)
    const { afpts, mp3s } = await generateFiles(env, trim, modes, audioFiles, precomputedFiles)
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
        info(`Searching ${afpts.length} precomputed audio files with ${Mode.AUDFPRINT} mode`)
        const pklzCount = readFileSync(consts.PKLZS_FILE, 'utf-8').trim().split('\n').length
        info(`Loaded a total of ${pklzCount} PKLZ files from the folder "database/${folder || ''}"`)
        info(`Using ${threads} concurrent threads for processing`)
        await audfprint(env, threads)
        info(`Search completed with ${Mode.AUDFPRINT} mode, now analyzing results... Please wait and do not close the program`)
        await createAudfprintLogs(env)
    }
    if(existsSync(RESULTS_FOLDER) && readdirSync(RESULTS_FOLDER).some(file => extname(file) === '.txt'))
        info(`Execution complete! Check logs results in: ${RESULTS_FOLDER}`)
    else
        info('Execution complete! Unfortunately, no results were found')
}

init()
