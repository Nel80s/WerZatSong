/*
 * One WerZatSong run per install.
 *
 * Every run wipes temp/, precomputed/ and processed/ on start and works out of
 * the shared input/ folder, so two overlapping runs destroy each other's work.
 * Several things can launch runs on one machine - a front end, a scheduled
 * task, people by hand - so the rule has to live in the one place they all pass
 * through: werzatsong.js itself, plus this file for launchers that need to hold
 * the lock for longer than the run (because they download into input/ first,
 * for example).
 *
 * The lock is <install>/werzatsong.lock, created with O_EXCL:
 *   { pid, token, owner, startedAt, command }
 * A launcher that already holds it passes its token to the run it starts via
 * WERZATSONG_LOCK_TOKEN, and that run proceeds under the parent's lock.
 * A lock whose pid is gone (or now belongs to some unrelated program) is stale
 * and is taken over. werzatsong-daily.ps1 implements the same protocol.
 */

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } = require('node:fs')
const { join } = require('node:path')

const LOCK_FILE = join(__dirname, '..', 'werzatsong.lock')
const TOKEN_ENV = 'WERZATSONG_LOCK_TOKEN'
// Processes that can legitimately own the lock. Anything else holding a
// recycled pid means the real owner is long gone.
const OWNER_IMAGES = new Set(['node.exe', 'node', 'powershell.exe', 'pwsh.exe'])

const FRESH_LOCK_MS = 10_000

function fileAgeMs(){
    try { return Date.now() - statSync(LOCK_FILE).mtimeMs }
    catch { return Infinity }
}

function readLock(){
    try {
        const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'))
        return lock && typeof lock === 'object' ? lock : null
    }
    catch {
        return null
    }
}

function imageName(pid){
    if(process.platform !== 'win32')
        return null
    try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 })
        const match = out.match(/^"([^"]+)"/m)
        return match ? match[1].toLowerCase() : null
    }
    catch {
        return null
    }
}

// Is the process recorded in this lock still the one that took it?
function isHeld(lock){
    const pid = Number(lock?.pid)
    if(!Number.isInteger(pid) || pid <= 0)
        return false
    try {
        process.kill(pid, 0)
    }
    catch(error){
        if(error.code !== 'EPERM') // EPERM: exists, just not ours to signal
            return false
    }
    const image = imageName(pid)
    return image === null ? true : OWNER_IMAGES.has(image)
}

function describe(lock){
    if(!lock)
        return 'another WerZatSong run'
    const since = lock.startedAt ? ` since ${new Date(lock.startedAt).toLocaleString()}` : ''
    return `${lock.owner || 'a WerZatSong run'} (pid ${lock.pid}${since})`
}

/*
 * Returns one of
 *   { acquired: true, token, inherited, release() }
 *   { acquired: false, holder }        - someone else is running
 * `owner` is a short label ("werzatsong.js", "my-launcher", ...).
 */
function acquire(owner, { token: inheritToken = process.env[TOKEN_ENV], command = process.argv.join(' ') } = {}){
    if(inheritToken){
        const current = readLock()
        if(current && current.token === inheritToken && isHeld(current))
            return { acquired: true, token: inheritToken, inherited: true, release(){} }
    }

    const token = crypto.randomBytes(16).toString('hex')
    const body = JSON.stringify({ pid: process.pid, token, owner, startedAt: new Date().toISOString(), command }, null, 2)
    let tookOverStale = false
    for(let attempt = 0; attempt < 3; attempt++){
        try {
            const fd = openSync(LOCK_FILE, 'wx')
            try { writeSync(fd, body) }
            finally { closeSync(fd) }
        }
        catch(error){
            if(error.code !== 'EEXIST')
                throw error
            const holder = readLock()
            if(holder && isHeld(holder))
                return { acquired: false, holder }
            // Unreadable and brand new: its owner is between creating and
            // writing it. Not stale - just not readable yet.
            if(!holder && fileAgeMs() < FRESH_LOCK_MS)
                return { acquired: false, holder: null }
            // Stale (dead owner, or an old unreadable file): clear it and try again.
            try { unlinkSync(LOCK_FILE) }
            catch { /* someone else cleared it first */ }
            tookOverStale = true
            continue
        }
        // Two processes clearing the same stale lock can each delete the
        // other's fresh one. Only the one whose token survives proceeds.
        if(tookOverStale){
            const start = Date.now()
            while(Date.now() - start < 250) { /* brief settle, sync on purpose */ }
            const now = readLock()
            if(!now || now.token !== token)
                return { acquired: false, holder: now }
        }
        let released = false
        const release = () => {
            if(released)
                return
            released = true
            const current = readLock()
            if(current && current.token === token){
                try { unlinkSync(LOCK_FILE) }
                catch { /* best effort */ }
            }
        }
        return { acquired: true, token, inherited: false, release }
    }
    return { acquired: false, holder: readLock() }
}

module.exports = { LOCK_FILE, TOKEN_ENV, acquire, describe, isHeld, readLock }
