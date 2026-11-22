const { readFileSync, writeFileSync } = require('node:fs')
const readline = require('node:readline')
const consts = require('./consts')
const { exit, warning } = require('./messages')
const postWebhook = require('./webhook')
const { postAudiotag } = require('../scripts/audiotag')

const ACOUSTID_KEY_REGEX = /^[a-zA-Z0-9_.-]{10}$/
const AUDIOTAG_KEY_REGEX = /^[a-z0-9]{32}$/
const DEFAULT_DURATION = '140:360' // min:max
const DEFAULT_EXTENSION = 10 // seconds
const DURATION_REGEX = /^\d+:\d+$/
const MAX_DURATION_ALLOWED = 600 // seconds
const MIN_DURATION_ALLOWED = 30 // seconds
const MAX_EXTENSION_ALLOWED = 25 // seconds
const MIN_EXTENSION_ALLOWED = 1 // seconds
const WEBHOOK_MESSAGE = 'Welcome to __WerZatSong__!\nDeveloped by **Nel** with contributions from **Numerophobe**, **AzureBlast**, **Mystic65** and **EierkuchenHD**'
const WEBHOOK_REGEX = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_.-]+$/

async function requestValue(request){
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })
    return await new Promise(resolve => {
        rl.question(request, input => {
            rl.close()
            resolve(input.trim())
        })
    })
}

async function validateAudiotag(key){
    if(!key || !AUDIOTAG_KEY_REGEX.test(key)){
        warning('Audiotag API key is not set in .env file. Please provide a valid Audiotag API key')
        const keyInput = await requestValue('Paste your Audiotag API key here: ')
        let keyValidated = false
        if(AUDIOTAG_KEY_REGEX.test(keyInput)){
            const { success } = await postAudiotag('info', true, keyInput)
            keyValidated = success
            if(keyValidated){
                const envContent = readFileSync(consts.ENV_FILE, 'utf-8')
                const updatedEnv = envContent.includes('AUDIOTAG_KEY') ? envContent.replace(/AUDIOTAG_KEY=.*/, `AUDIOTAG_KEY=${keyInput}`) : `${envContent.trim()}\nAUDIOTAG_KEY=${keyInput}\n`
                writeFileSync(consts.ENV_FILE, updatedEnv)
                return keyInput
            }
        }
        if(!keyValidated)
            exit('The Audiotag API key you entered is invalid')
    }
    return null
}

function validateDuration(duration){
    if(typeof duration === 'string' && duration.length > 0 && DURATION_REGEX.test(duration.trim())){
        const [min, max] = duration.split(':').map(Number)
        return (min >= MIN_DURATION_ALLOWED && max <= MAX_DURATION_ALLOWED) ? duration.trim() : DEFAULT_DURATION
    }
    return DEFAULT_DURATION
}

function validateExtension(extension){
    if(typeof extension === 'number')
        return (extension <= MAX_EXTENSION_ALLOWED && extension >= MIN_EXTENSION_ALLOWED) ? extension : DEFAULT_EXTENSION
    return DEFAULT_EXTENSION
}

async function validateMusicbrainz(key){
    let keys = null
    if(key?.length > 0){
        const filtered = key.split(',').filter(k => ACOUSTID_KEY_REGEX.test(k))
        keys = filtered.length > 0 ? filtered : null
    }
    if(!key || !keys){
        warning('AcoustID API key is not set in .env file. Please provide a valid AcoustID API key')
        const keyInput = await requestValue('Paste your AcoustID API key here: ')
        const validKeys = keyInput?.split(',').map(k => k.trim()).filter(k => ACOUSTID_KEY_REGEX.test(k))
        if(validKeys?.length > 0){
            const envContent = readFileSync(consts.ENV_FILE, 'utf-8')
            const joinedKeys = validKeys.join(',')
            const updatedEnv = envContent.includes('ACOUSTID_KEY') ? envContent.replace(/ACOUSTID_KEY=.*/, `ACOUSTID_KEY=${joinedKeys}`) : `${envContent.trim()}\nACOUSTID_KEY=${joinedKeys}\n`
            writeFileSync(consts.ENV_FILE, updatedEnv)
            return joinedKeys
        }
        else
            exit('The AcoustID API key you entered is invalid')
    }
    return null
}

async function validateWebhook(webhook){
    if(!webhook || !WEBHOOK_REGEX.test(webhook)){
        warning('Discord webhook is not set in .env file. Please provide a valid Discord webhook URL')
        const webhookInput = await requestValue('Paste your Discord webhook URL here: ')
        let webhookSent = false
        if(WEBHOOK_REGEX.test(webhookInput)){
            webhookSent = await postWebhook(webhookInput, WEBHOOK_MESSAGE)
            if(webhookSent){
                const envContent = readFileSync(consts.ENV_FILE, 'utf-8')
                const updatedEnv = envContent.includes('WEBHOOK_URL') ? envContent.replace(/WEBHOOK_URL=.*/, `WEBHOOK_URL=${webhookInput}`) : `${envContent.trim()}\nWEBHOOK_URL=${webhookInput}\n`
                writeFileSync(consts.ENV_FILE, updatedEnv)
                return webhookInput
            }
        }
        if(!webhookSent)
            exit('The Discord webhook URL you entered is invalid')
    }
    return null
}

module.exports = {
    validateAudiotag,
    validateDuration,
    validateExtension,
    validateMusicbrainz,
    validateWebhook
}
