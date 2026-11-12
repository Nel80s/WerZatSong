const FormData = require('form-data')
const { readFileSync } = require('node:fs')
const { basename } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { request } = require('undici')

const WEBHOOK_AVATAR = 'https://cdn.discordapp.com/icons/1280127901852893244/ea65cd62d0824f7aab1f0bf751364818.webp'
const WEBHOOK_USERNAME = 'WerZatSong'

// A match that is not posted is lost - the run never comes back to it - so a
// rate limit or a brief Discord outage is worth riding out. Three retries in
// all keeps a webhook that is really gone from stalling an unattended run.
const MAX_RETRIES = 3
// After a 5xx or a network error: 2 s, then 4 s, then 8 s.
const RETRY_BASE_MS = 2000
// 520-524 are Cloudflare's own "Discord did not answer properly" errors from
// the edge in front of it: as passing as a 502.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524])
// Discord's retry_after is normally a fraction of a second. The cap stops a
// pathological value (a global limit, a misbehaving proxy) from hanging the
// run on a single post.
const MAX_RATE_LIMIT_WAIT_MS = 60 * 1000
// undici waits five minutes for headers and five more for the body by
// default. Discord answers in well under a second, so a request still open
// after 30 s is treated like a dropped connection and retried.
const REQUEST_TIMEOUT_MS = 30 * 1000
// When posts keep failing even after their retries, Discord or the way to it
// is down, and every further post of the run would spend minutes retrying (a
// hung endpoint costs about 2 1/4 minutes per post: a 30-clip run would wait
// over an hour). After this many posts in a row have failed, the rest get one
// quick try each until one gets through again.
const FAILED_POSTS_BEFORE_QUICK = 2
const QUICK_TIMEOUT_MS = 10 * 1000
let failedPostsInARow = 0

// Discord finds mentions in the raw text, code blocks included, so a file
// name such as "@everyone - live.mp3" in a match report would ping the whole
// server. A zero-width space right after the "@" breaks the mention and looks
// the same. Nothing else is touched: the fences, the column layout and the
// fullwidth characters yt-dlp puts in file names must arrive as written.
// Running it twice changes nothing, because the inserted character already
// stands between the "@" and the rest of the mention.
const MENTION_PATTERN = /@(?=everyone|here)|<@(?=[!&]?\d+>)/gi

function neutraliseMentions(content){
    if(typeof content !== 'string')
        return content
    return content.replace(MENTION_PATTERN, '$&​')
}

function buildRequest(content, attachment, timeoutMs){
    const options = {
        method: 'POST',
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
    }
    if(attachment){
        // A form-data stream is used up by the first send, so every attempt
        // gets a fresh one. The field layout is the one known to work with
        // Discord and is kept as it is; allowed_mentions is left out on
        // purpose, the content has already been made harmless.
        const formData = new FormData()
        // Verbatim. This used to wrap the content in single backticks,
        // which was fine when callers passed a bare one-line header but
        // breaks anything that brings its own markdown - a fenced code
        // block comes out with a stray backtick glued to each end.
        formData.append('content', content)
        formData.append('username', WEBHOOK_USERNAME)
        formData.append('avatar_url', WEBHOOK_AVATAR)
        formData.append('file', attachment.data, {
            filename: attachment.name,
            contentType: 'text/plain'
        })
        options.headers = formData.getHeaders()
        options.body = formData
    }
    else {
        options.headers = { 'Content-Type': 'application/json' }
        options.body = JSON.stringify({
            content,
            username: WEBHOOK_USERNAME,
            avatar_url: WEBHOOK_AVATAR,
            // Belt and braces: even a mention the pattern above missed is
            // shown as text and pings nobody.
            allowed_mentions: { parse: [] }
        })
    }
    return options
}

// undici keeps the connection busy until the response body has been read, so
// every response is drained, including the ones nobody looks at.
async function discard(body){
    try { await body.dump() }
    catch {}
}

function parseRetryAfterHeader(value){
    if(Array.isArray(value))
        value = value[0]
    if(typeof value !== 'string' || value.trim() === '')
        return null
    const seconds = Number(value)
    if(Number.isFinite(seconds))
        return seconds * 1000
    // The HTTP spec also allows a date here. Discord sends seconds, but a
    // proxy in between might not.
    const date = Date.parse(value)
    return Number.isNaN(date) ? null : date - Date.now()
}

// How long Discord asked us to wait. The headers come first because their
// unit never changes: X-RateLimit-Reset-After and Retry-After are seconds. The
// JSON body's retry_after is seconds in today's API but milliseconds in the
// v6 API that unversioned webhook URLs can still get, so it is only the
// fallback for a reply without those headers (an HTML page from a proxy, say).
async function rateLimitWait(headers, body){
    let text = ''
    try { text = await body.text() }
    catch { await discard(body) }
    let waitMs = null
    const resetAfter = Number(Array.isArray(headers['x-ratelimit-reset-after']) ? headers['x-ratelimit-reset-after'][0] : headers['x-ratelimit-reset-after'])
    if(headers['x-ratelimit-reset-after'] !== undefined && Number.isFinite(resetAfter))
        waitMs = resetAfter * 1000
    if(waitMs === null)
        waitMs = parseRetryAfterHeader(headers['retry-after'])
    if(waitMs === null){
        try {
            const retryAfter = JSON.parse(text)?.retry_after
            const seconds = typeof retryAfter === 'string' ? Number(retryAfter) : retryAfter
            if(typeof seconds === 'number' && Number.isFinite(seconds))
                waitMs = seconds * 1000
        }
        catch {}
    }
    if(waitMs === null)
        waitMs = RETRY_BASE_MS
    return Math.min(Math.max(waitMs, 0), MAX_RATE_LIMIT_WAIT_MS)
}

// A bad URL fails the same way every time; only network trouble is worth
// waiting out.
function isPermanentError(error){
    return error instanceof TypeError || error?.code === 'UND_ERR_INVALID_ARG'
}

async function postWebhook(url, content, filePath = null){
    const sent = await attemptPost(url, content, filePath)
    failedPostsInARow = sent ? 0 : failedPostsInARow + 1
    return sent
}

async function attemptPost(url, content, filePath){
    const quick = failedPostsInARow >= FAILED_POSTS_BEFORE_QUICK
    const maxRetries = quick ? 0 : MAX_RETRIES
    const timeoutMs = quick ? QUICK_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    try {
        content = neutraliseMentions(content)
        // The attachment is read once and resent from memory on a retry. A
        // file that is missing or unreadable no longer sinks the whole post:
        // the message goes out without it, which beats no message at all.
        let attachment = null
        if(filePath){
            try { attachment = { data: readFileSync(filePath), name: basename(filePath) } }
            catch {}
        }
        let serverFailures = 0
        for(let attempt = 0; ; attempt++){
            const options = buildRequest(content, attachment, timeoutMs)
            let waitMs
            try {
                const { statusCode, headers, body } = await request(url, options)
                // 204 is what a plain webhook returns; ?wait=true answers 200
                // with the created message. Both mean it was posted.
                if(statusCode >= 200 && statusCode < 300){
                    await discard(body)
                    return true
                }
                if(statusCode === 429)
                    waitMs = await rateLimitWait(headers, body)
                else {
                    await discard(body)
                    // 400/401/404 and the like will not get better by asking
                    // again.
                    if(!RETRYABLE_STATUS.has(statusCode))
                        return false
                    waitMs = RETRY_BASE_MS * 2 ** serverFailures++
                }
            }
            catch(error){
                if(isPermanentError(error))
                    return false
                waitMs = RETRY_BASE_MS * 2 ** serverFailures++
            }
            if(attempt >= maxRetries)
                return false
            await sleep(waitMs)
        }
    }
    catch {
        return false
    }
}

module.exports = postWebhook
// Exposed so a caller that budgets the 2000-character limit can measure the
// text as it will actually be sent.
module.exports.neutraliseMentions = neutraliseMentions
// For tests: forget earlier failures, as a new run does.
module.exports.resetFailureCount = () => { failedPostsInARow = 0 }
