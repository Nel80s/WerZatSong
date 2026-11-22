/*
 * JSON objects too big for one string.
 *
 * Node cannot hold a string longer than buffer.constants.MAX_STRING_LENGTH
 * (2^29 - 24 characters, about 512 MB). JSON.stringify of a large result set
 * therefore fails with "Invalid string length", and readFileSync(path, 'utf-8')
 * cannot return such a file either. These functions write an object a few
 * thousand entries per line and read it back line by line, so no string ever
 * holds more than one line. The file is still ordinary JSON:
 *
 *   {"version":1,"done":[...],"results":{     <- the head, up to the entries
 *   "first key":{...},"second key":{...},...,
 *   "key 2001":{...},...
 *   }}                                        <- the closing braces
 *
 * or, without head fields, "{", the lines of entries, "}". A file written whole
 * by JSON.stringify (a single line) is read too, as long as it fits a string.
 * Entries keep the order of the object they came from.
 */

const { closeSync, openSync, readSync, writeSync } = require('node:fs')
const { StringDecoder } = require('node:string_decoder')

const CHUNK_BYTES = 1 << 20
// Entries per line: parsing a line of a few thousand entries at once is faster
// than parsing each entry on its own, and a line stays around a megabyte.
const ENTRIES_PER_LINE = 2000

function writeAll(fd, text){
    const bytes = Buffer.from(text, 'utf-8')
    let offset = 0
    while(offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset)
}

// Collects text and writes it in chunks of about CHUNK_BYTES.
function chunkedWriter(fd){
    let parts = []
    let length = 0
    return {
        add(text){
            parts.push(text)
            length += text.length
            if(length >= CHUNK_BYTES)
                this.flush()
        },
        flush(){
            if(parts.length === 0)
                return
            writeAll(fd, parts.join(''))
            parts = []
            length = 0
        }
    }
}

// The first line of the file: the head fields, then the opening brace of the
// entries. Without an entriesKey the entries are the object itself.
function openingOf(head, entriesKey){
    if(entriesKey === null)
        return '{'
    const fields = JSON.stringify(head || {})
    return `${fields.slice(0, -1)}${fields === '{}' ? '' : ','}${JSON.stringify(entriesKey)}:{`
}

// Writes entries (an object) to path, ENTRIES_PER_LINE entries per line. With
// an entriesKey the file is { ...head, [entriesKey]: entries }; head holds small
// fields only.
function writeObjectLines(path, entries, { head = null, entriesKey = null } = {}){
    const fd = openSync(path, 'w')
    try {
        const out = chunkedWriter(fd)
        out.add(openingOf(head, entriesKey))
        let separator = '\n'
        let line = {}
        let count = 0
        const writeLine = () => {
            if(count === 0)
                return
            const text = JSON.stringify(line)
            out.add(`${separator}${text.slice(1, -1)}`)
            separator = ',\n'
            line = {}
            count = 0
        }
        for(const key of Object.keys(entries)){
            line[key] = entries[key]
            if(++count >= ENTRIES_PER_LINE)
                writeLine()
        }
        writeLine()
        out.add(entriesKey === null ? '\n}\n' : '\n}}\n')
        out.flush()
    }
    finally {
        closeSync(fd)
    }
}

// The head of a file from its first line: { head, whole }. whole is the parsed
// object when the first line is the complete file (written by JSON.stringify),
// else null.
function parseFirstLine(line, entriesKey){
    let whole = null
    try { whole = JSON.parse(line) }
    catch { /* the opening line of a file written one entry per line */ }
    if(whole !== null){
        if(typeof whole !== 'object' || Array.isArray(whole))
            throw new Error('not a JSON object')
        if(entriesKey === null)
            return { head: {}, whole }
        const { [entriesKey]: _entries, ...head } = whole
        return { head, whole }
    }
    if(entriesKey === null){
        if(line.trim() !== '{')
            throw new Error('not a file written one entry per line')
        return { head: {}, whole: null }
    }
    const opened = JSON.parse(`${line}}}`)
    if(typeof opened[entriesKey] !== 'object')
        throw new Error('not a file written one entry per line')
    const { [entriesKey]: _entries, ...head } = opened
    return { head, whole: null }
}

// Reads path line by line. Calls onLine(line) for each line and stops early
// when it returns false.
function forEachLine(path, onLine){
    const fd = openSync(path, 'r')
    try {
        const decoder = new StringDecoder('utf8')
        const buffer = Buffer.alloc(CHUNK_BYTES)
        let rest = ''
        for(;;){
            const count = readSync(fd, buffer, 0, buffer.length, null)
            if(count === 0)
                break
            const lines = (rest + decoder.write(buffer.subarray(0, count))).split('\n')
            rest = lines.pop()
            for(const line of lines){
                if(onLine(line.endsWith('\r') ? line.slice(0, -1) : line) === false)
                    return
            }
        }
        rest += decoder.end()
        if(rest !== '')
            onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest)
    }
    finally {
        closeSync(fd)
    }
}

// Reads a file writeObjectLines wrote, or a small one JSON.stringify wrote.
// Calls onEntry(key, value) for every entry; returns the head fields.
function readObjectLines(path, onEntry, { entriesKey = null } = {}){
    let head = null
    let closed = false
    forEachLine(path, line => {
        if(head === null){
            const first = parseFirstLine(line, entriesKey)
            head = first.head
            if(first.whole !== null){
                const entries = entriesKey === null ? first.whole : first.whole[entriesKey]
                if(!entries || typeof entries !== 'object')
                    throw new Error(`no "${entriesKey}" in the file`)
                for(const key of Object.keys(entries))
                    onEntry(key, entries[key])
                closed = true
                return false
            }
            return true
        }
        if(/^\}+$/.test(line.trim())){
            closed = true
            return false
        }
        if(line.trim() === '')
            return true
        const entry = JSON.parse(`{${line.endsWith(',') ? line.slice(0, -1) : line}}`)
        for(const key of Object.keys(entry))
            onEntry(key, entry[key])
        return true
    })
    if(head === null)
        throw new Error('the file is empty')
    if(!closed)
        throw new Error('the file ends before its closing brace')
    return head
}

// Only the head fields: reads the first line and no further (a file written
// whole by JSON.stringify is read in full).
function readObjectHead(path, { entriesKey = null } = {}){
    let head = null
    forEachLine(path, line => {
        head = parseFirstLine(line, entriesKey).head
        return false
    })
    if(head === null)
        throw new Error('the file is empty')
    return head
}

module.exports = { writeObjectLines, readObjectLines, readObjectHead }
