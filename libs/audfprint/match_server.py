# coding=utf-8
"""
match_server.py - LOCAL ADDITION to audfprint (not upstream).

`audfprint.py match`, kept running. scripts/audfprint.js used to start a new
Python for every database file of a search - about 43,000 of them, each one
spending roughly 2.8 s importing numpy, scipy and joblib before it matched
anything. Now each worker thread starts this once and hands it one database
file at a time.

Every file goes through the command line's own code: options are parsed with
audfprint.py's USAGE, the analyzer, matcher and reporter come from its setup_*
functions, the table is loaded with hash_table.HashTable() and the queries are
matched by audfprint.do_cmd('match', ...). So the lines written for a file are
the ones `audfprint.py match --dbase <file> <same options>` prints. The only
difference: each query fingerprint (.afpt) is read once per process instead of
once per database file, because the queries do not change during a search.

Usage:
    python match_server.py <audfprint.py match options, without --dbase>
    e.g. python match_server.py --min-count 5 --max-matches 75 \
             --search-depth 10000 --list temp/_afpts.txt

Protocol, one JSON object per line:
    stdin   {"dbase": "<.pklz path>", "out": "<file to append that file's output to>"}
    stdout  {"dbase": "<same>", "ok": true}
            {"dbase": "<same>", "ok": false, "error": "<one line>"}
End of stdin ends the process.

LOCAL MODIFICATION (2026-11-11, load speed): a request may add
"trusted": [size, "mtime_ns"], what this file was when its checksum was last
verified; if it still is that, it is read without the CRC32. A reply to a file
that loaded says what was read: "size", "mtime_ns" (a string) and "verified"
(true when the checksum was checked this time and held). Every table is
inflated into the same memory, as this process holds one at a time. Both are
explained in hash_table.py (_read_pklz).

LOCAL MODIFICATION (2026-11-11, read ahead): a request may also add
"next": "<the .pklz this matcher is asked for after this one>". A thread reads
that file into memory while this one is inflated and matched, so the next
load does not have to wait for the disk: reading and computing overlap
instead of taking turns. That matters most where a read is slow to be served
(a busy or slow drive, or the low I/O priority a scheduled task gets on
Windows: there 24 matchers taking turns got about 180 MiB/s out of a drive
that gives 24 waiting readers 290). The bytes are the file's own, so nothing
about a table changes. Files over PREFETCH_MAX_BYTES are left to the normal
reader, which never holds a whole file: with one read ahead a matcher holds
the table, the file it is inflating and the next file, and that has to stay
within the memory werzatsong.js counts per thread (MATCHER_PEAK_BYTES).

LOCAL MODIFICATION (2026-11-12, disk priority): DISK_PRIORITY=normal in .env
makes this process read at normal I/O priority. It only matters on Windows
where a search is started by a scheduled task: a task runs at priority 7
unless it says otherwise, and everything below it then reads at low I/O
priority, where requests are served one after the other. All matchers
together then get what a single reader gets from the drive (measured here:
335 to 400 MiB/s, against 813 for 16 readers at normal priority). The CPU
priority is left as it is. Without the setting nothing changes.

Re-apply this if audfprint is ever updated from upstream.
"""
from __future__ import division, print_function

import contextlib
import gc
import json
import os
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import docopt
import numpy as np

# Importing audfprint also switches stdout/stderr to UTF-8 on Windows, as the
# command line does; requests arrive as UTF-8 too.
import audfprint
import audfprint_analyze
import hash_table

if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8")

_read_hashes = audfprint_analyze.hashes_load
_hashes_by_file = {}


def _hashes_load_once(hashfilename):
    """hashes_load() for a query fingerprint, read from disk only the first time.
    Kept as the int64 array numpy makes of hashes_load()'s list anyway, so the
    matcher sees the same values without converting the list on every file."""
    hashes = _hashes_by_file.get(hashfilename)
    if hashes is None:
        hashes = np.asarray(_read_hashes(hashfilename))
        _hashes_by_file[hashfilename] = hashes
    return hashes


audfprint_analyze.hashes_load = _hashes_load_once


PREFETCH_MAX_BYTES = 96 << 20


class _ReadAhead(object):
    """ The next database file, read into memory by a thread. """

    def __init__(self):
        self._box = None
        self._thread = None

    @staticmethod
    def _read(box):
        try:
            with open(box['path'], 'rb', buffering=0) as f:
                status = os.fstat(f.fileno())
                if status.st_size > PREFETCH_MAX_BYTES:
                    return
                data = f.read()
            if len(data) == status.st_size:
                box['loaded'] = (data, (status.st_size, status.st_mtime_ns))
        except Exception:
            # The matcher reads the file itself and reports what is wrong.
            pass

    def start(self, path):
        """ Begin reading <path>; what an earlier call began is given up. """
        self._box = {'path': path, 'loaded': None}
        self._thread = threading.Thread(target=self._read, args=(self._box,))
        self._thread.daemon = True
        self._thread.start()

    def take(self, path):
        """ (bytes, (size, mtime_ns)) of <path> if it is the file being read
            ahead and it could be read; None otherwise. Waits for the read. """
        box, thread = self._box, self._thread
        self._box = self._thread = None
        if box is None or box['path'] != path:
            return None
        thread.join()
        return box['loaded']


def _set_disk_priority():
    """ DISK_PRIORITY=normal: read at normal I/O priority (see the top). """
    if os.name != 'nt':
        return
    if os.environ.get('DISK_PRIORITY', '').strip().lower() != 'normal':
        return
    try:
        import ctypes
        kernel32 = ctypes.WinDLL('kernel32')
        ntdll = ctypes.WinDLL('ntdll')
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        normal = ctypes.c_ulong(2)      # IoPriorityNormal
        # 33: ProcessIoPriority
        ntdll.NtSetInformationProcess(
            ctypes.c_void_p(kernel32.GetCurrentProcess()), 33,
            ctypes.byref(normal), ctypes.sizeof(normal))
    except Exception:
        # Not worth failing a search over.
        pass


def _reply(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def match_one(args, analyzer, matcher, report, dbasename, trusted=None,
              preloaded=None):
    """What audfprint.main() does for `match` with one database file.
       Returns hash_table.last_load for the file."""
    # Per-file totals, as each command-line run started from zero.
    analyzer.soundfiletotaldur = 0.0
    analyzer.soundfilecount = 0
    initticks = audfprint.time_clock()
    if args['--verbose']:
        report([time.ctime() + " Reading hash table " + dbasename])
    # preloaded: a list holding the file's bytes if they were read ahead.
    # Taken out of it here, so that nothing keeps them once the table is
    # loaded.
    hash_tab = hash_table.HashTable(
        dbasename, trusted=trusted,
        preloaded=preloaded.pop() if preloaded else None)
    loaded = dict(hash_table.last_load)
    try:
        if analyzer and 'samplerate' in hash_tab.params \
                and hash_tab.params['samplerate'] != analyzer.target_sr:
            print("db samplerate overridden to ", analyzer.target_sr)
        filename_iter = audfprint.filename_list_iterator(
                args['<file>'], args['--wavdir'], args['--wavext'], args['--list'])
        audfprint.do_cmd('match', analyzer, hash_tab, filename_iter,
                         matcher, args['--precompdir'], 'hashes', report,
                         skip_existing=args['--skip-existing'],
                         strip_prefix=args['--wavdir'])
        elapsedtime = audfprint.time_clock() - initticks
        if analyzer and analyzer.soundfiletotaldur > 0.:
            print("Processed "
                  + "%d files (%.1f s total dur) in %.1f s sec = %.3f x RT"
                  % (analyzer.soundfilecount, analyzer.soundfiletotaldur,
                     elapsedtime, (elapsedtime / analyzer.soundfiletotaldur)))
    finally:
        # Let go of the table before the next one is loaded into its memory.
        del hash_tab
    return loaded


def main(argv):
    args = docopt.docopt(audfprint.USAGE, version=audfprint.__version__,
                         argv=['match', '--dbase', 'given-per-request'] + argv[1:])
    if args["--maxtimebits"]:
        args["--maxtimebits"] = int(args["--maxtimebits"])
    else:
        args["--maxtimebits"] = hash_table._bitsfor(int(args["--maxtime"]))
    if int(args['--ncores']) > 1:
        raise ValueError("match_server.py runs one database file at a time; leave --ncores at 1")
    analyzer = audfprint.setup_analyzer(args)
    matcher = audfprint.setup_matcher(args)
    report = audfprint.setup_reporter(args)
    # One table at a time here, so they can all use the same memory.
    hash_table.reuse_table_memory()
    read_ahead = _ReadAhead()
    _set_disk_priority()

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            dbasename, out = request["dbase"], request["out"]
            trusted = request.get("trusted")
            following = request.get("next")
        except Exception as error:
            _reply({"dbase": None, "ok": False, "error": "bad request: %s" % error})
            continue
        # This file, if it was read ahead; then the read of the next one
        # starts, to run while this one is inflated and matched.
        preloaded = [read_ahead.take(dbasename)]
        if following:
            read_ahead.start(following)
        try:
            with open(out, "a", encoding="utf-8") as output, contextlib.redirect_stdout(output):
                loaded = match_one(args, analyzer, matcher, report, dbasename,
                                   trusted, preloaded)
        except Exception as error:
            # One unreadable or oversized file costs that file, not the process.
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
            del preloaded[:]
            gc.collect()
            last = traceback.format_exception_only(type(error), error)[-1].strip()
            _reply({"dbase": dbasename, "ok": False, "error": last})
            continue
        _reply({"dbase": dbasename, "ok": True,
                "verified": bool(loaded.get("verified")),
                "size": loaded.get("size"),
                "mtime_ns": str(loaded.get("mtime_ns"))})


if __name__ == "__main__":
    main(sys.argv)
