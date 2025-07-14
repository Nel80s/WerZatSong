const dotenv = require('dotenv')
const { exec } = require('node:child_process')
const cluster = require('node:cluster')
const { copyFileSync, unlinkSync, writeFileSync } = require('node:fs')
const { availableParallelism } = require('node:os')
const { basename, join } = require('node:path')
const { promisify } = require('node:util')
const { hideBin } = require('yargs/helpers')
const yargs = require('yargs/yargs')
const consts = require('../utils/consts')
const { trimExtension } = require('../utils/helpers')

dotenv.config()

const MAX_CORES_ALLOWED = 8 // avoid out of memory error
const MUSICBRAINZ_LIMIT = 110 // seconds

const execPromise = promisify(exec)
const { argv } = yargs(hideBin(process.argv))

async function extendFile(file, offset){
    const destPath = join(consts.TEMP_FOLDER, `${trimExtension(basename(file))}-${offset}.mp3`)
    if(offset === 0)
        copyFileSync(file, destPath)
    else
        await execPromise(`${process.env.FFMPEG_COMMAND} -i "${consts.FILLER_FILE}" -i "${file}" -filter_complex "[0:a]atrim=0:${offset},asetpts=PTS-STARTPTS[trimmed];[trimmed][1:a]concat=n=2:v=0:a=1[concat];[concat]atrim=0:${MUSICBRAINZ_LIMIT},asetpts=PTS-STARTPTS[final]" -map "[final]" -c:a libmp3lame -q:a 2 -ar 44100 "${destPath}"`)
    return destPath
}

async function calculateFingerprint(file, offset){
    const filePath = await extendFile(file, offset)
    const fpcalcBin = process.platform ==='linux' ? 'fpcalc_linux'
                    : process.platform === 'darwin' ? 'fpcalc_macos'
                    : 'fpcalc.exe'
    const fpcalc = join(__dirname, '..', 'libs', 'fpcalc', fpcalcBin)
    const { stdout } = await execPromise(`${fpcalc} -length ${MUSICBRAINZ_LIMIT} -json "${filePath}"`)
    const { fingerprint } = JSON.parse(stdout.trim())
    unlinkSync(filePath)
    return fingerprint
}

if(cluster.isPrimary){
    const cpuCores = Math.min(MAX_CORES_ALLOWED, availableParallelism())
    const { extension, file } = argv
    const fingerprints = {}
    const offsets = Array.from({ length: parseInt(extension) + 1 }, (_, i) => i)
    const chunks = Array.from({ length: cpuCores }, () => [])
    offsets.forEach((offset, index) => {
        chunks[index % cpuCores].push(offset)
    })
    let completed = 0
    for(let i = 0; i < cpuCores; i++){
        const worker = cluster.fork()
        worker.send({ file, offsets: chunks[i] })
        worker.on('message', message => {
            if(message.status === 'done'){
                completed += 1
                fingerprints[String(message.offset)] = message.fingerprint
                if(completed === offsets.length){
                    writeFileSync(join(consts.TEMP_FOLDER, `${trimExtension(basename(file))}.json`), JSON.stringify({ fingerprints }))
                    process.exit()
                }
            }
        })
    }
}
else {
    process.on('message', async ({ file, offsets }) => {
        for(const offset of offsets){
            const fingerprint = await calculateFingerprint(file, offset)
            process.send({ status: 'done', offset, fingerprint })
        }
    })
}
