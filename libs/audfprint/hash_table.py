# coding=utf-8
"""
hash_table.py

Python implementation of the very simple, fixed-array hash table
used for the audfprint fingerprinter.

2014-05-25 Dan Ellis dpwe@ee.columbia.edu
"""
from __future__ import division, print_function

import gzip
import io
import math
import os
import random
import sys
import zlib

import numpy as np
import scipy.io

if sys.version_info[0] >= 3:
    # Python 3 specific definitions
    import pickle  # Py3
    basestring = (str, bytes)  # Py3
    pickle_options = {'encoding': 'latin1'}
else:
    # Python 2 specific definitions
    import cPickle as pickle  # Py2
    pickle_options = {}


# Current format version
HT_VERSION = 20170724

# LOCAL MODIFICATION (not upstream audfprint).
#
# A .pklz is a gzipped pickle, and unpickling can run arbitrary code: a crafted
# database file would execute as whoever runs the match - a service account,
# when a scheduled task starts the scan. Database files are downloaded and passed
# around, so only the few classes a genuine hash table is made of are let
# through. Surveyed on 2026-09-23 across all 44 database folders here: every file
# references exactly HashTable, numpy.dtype and numpy's _frombuffer; the other
# numpy entries are the array/scalar reconstructors older numpy versions wrote.
#
# Re-apply this if audfprint is ever updated from upstream.
_PKLZ_ALLOWED_GLOBALS = {
    ('numpy', 'dtype'),
    ('numpy', 'ndarray'),
    ('numpy.core.numeric', '_frombuffer'),
    ('numpy._core.numeric', '_frombuffer'),
    ('numpy.core.multiarray', '_reconstruct'),
    ('numpy._core.multiarray', '_reconstruct'),
    ('numpy.core.multiarray', 'scalar'),
    ('numpy._core.multiarray', 'scalar'),
}
_PKLZ_HASHTABLE_MODULES = {'hash_table', 'audfprint.hash_table', 'audfprint_hash_table'}
# Earliest acceptable version
HT_COMPAT_VERSION = 20170724
# Earliest version that can be updated with load_old
HT_OLD_COMPAT_VERSION = 20140920


def _bitsfor(maxval):
    """ Convert a maxval into a number of bits (left shift).
        Raises a ValueError if the maxval is not a power of 2. """
    maxvalbits = int(round(math.log(maxval) / math.log(2)))
    if maxval != (1 << maxvalbits):
        raise ValueError("maxval must be a power of 2, not %d" % maxval)
    return maxvalbits


def _load_pklz_pickle(file_object, buffers=None):
    """pickle.load() limited to what an audfprint hash table contains.
       buffers: see _TableDiverter."""
    if sys.version_info[0] < 3:
        return pickle.load(file_object, **pickle_options)

    class _PklzUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if name == 'HashTable' and module in _PKLZ_HASHTABLE_MODULES:
                return HashTable
            if (module, name) in _PKLZ_ALLOWED_GLOBALS:
                return super().find_class(module, name)
            raise pickle.UnpicklingError(
                'refusing to load %s.%s from a database file: not part of an '
                'audfprint hash table' % (module, name))

    if buffers is not None:
        return _PklzUnpickler(file_object, buffers=buffers,
                              **pickle_options).load()
    return _PklzUnpickler(file_object, **pickle_options).load()


# LOCAL MODIFICATION (not upstream audfprint).
#
# A search loads every one of the ~41,700 database files, and loading one was
# most of the time spent on it. gzip.open() has no readinto(), so pickle got
# the ~420 MB table array as one bytes object and copied it into its own
# buffer: every load held the table twice for a moment, in every worker. It
# also checks a member's CRC32 and length only when something reads past the
# member's end, and pickle stops at its last opcode, so a damaged file could
# load as a damaged table. And load() added up the 2^20 bucket counts twice
# with Python's sum(), one numpy scalar at a time.
#
# Now zlib inflates the file straight into the buffer pickle reads into, a
# quarter megabyte at a time, and checks every member's CRC32 and length;
# after unpickling, load_pkl() has the rest of the file inflated and checked
# too. A failed check raises, since it can mean damaged data as well as a
# damaged checksum, and so does corrupt deflate data anywhere in the file. A
# file that is empty, is not gzip or ends before the pickle does raises as
# before. A file that is only cut short after the data, or has something
# added after it, still loads, as it did when nothing read that far: if the
# file ends before the trailer of its last member is complete, or a member
# that checked out is followed by something that is neither zero padding nor
# another member, the table is kept and one warning line goes to stderr.
# load() sums with numpy.
#
# Measured on 2026-11-05 on six tables of 0.4 to 358 MB: identical tables and
# output, 0.5 to 0.9 s less per load, peak memory down from about twice the
# table to the table plus a few MB. Reading the whole file and inflating it in
# one go (gzip.decompress() or zlib) was no faster and held the compressed
# file, the inflated data and the table at the same time.
#
# Re-apply this if audfprint is ever updated from upstream.
_GZIP_READ_SIZE = 1 << 16
_GZIP_INFLATE_SIZE = 1 << 18

# LOCAL MODIFICATION (2026-11-11): the database file is opened with an 8 MiB
# buffer, so the disk is read 8 MiB at a time while zlib is still fed the
# 64 KiB pieces above from memory.
#
# Scans run below normal priority (the scheduled tasks' default priority 7),
# and Windows then gives every disk request low I/O priority, which costs
# about 14 ms per request however small it is. 64 KiB requests came to about
# 3.6 MiB/s per worker, so reading one ~30 MB file took longer than inflating
# it, and adding workers made scans no faster. Measured under a running scan,
# at low I/O priority: 64 KiB reads 3.6 MiB/s, 1 MiB 30, 4 MiB 87, 8 MiB 115;
# a whole load went from 13.0 s to 2.9 s per file on average, same tables.
#
# Feeding zlib the 8 MiB at once instead would not do: with a bounded output
# size it copies its unconsumed input on every call, gigabytes per file.
_DISK_READ_SIZE = 8 << 20


# LOCAL MODIFICATION (2026-11-11, load speed), not upstream audfprint.
#
# After the 8 MiB disk buffer a load was all CPU: on a 1.7 GHz Xeon about
# 1.35 s to inflate the 404 MiB table, 0.6 s for zlib to CRC32 those 404 MiB
# again, and 0.15 s of page faults for 404 MiB of fresh memory, for every one
# of the ~41,700 files of every search. Two things a caller can now ask for;
# without them everything loads exactly as before.
#
# 1. A file whose checksum this machine has verified before, and which has
#    not changed since (same size and modification time, taken from the open
#    file itself), can be read without the CRC32: HashTable(name, trusted=
#    (size, mtime_ns)). The gzip header is then stepped over here and the
#    bare deflate data inflated, which zlib does not checksum. Everything
#    else is still checked: the deflate data has to be valid to its end, every
#    member's length has to match its trailer, and what follows a member is
#    judged as before. scripts/audfprint.js keeps the list of verified files
#    (cache/pklz-verified.json) and has each one verified again after about a
#    month; VERIFY_CHECKSUMS=always in .env switches this off.
#
# 2. One caller that only ever holds one table at a time (match_server.py)
#    can have every table inflated into the same memory:
#    reuse_table_memory(). numpy (1.16 and later, pickle protocol 5) writes
#    an array as one BYTEARRAY8 item outside the pickle's frames, so
#    _TableDiverter inflates that item's bytes straight into the kept buffer
#    and gives the unpickler a NEXT_BUFFER opcode in its place; the array then
#    sits on the kept buffer instead of on 404 MiB of new memory. A pickle
#    laid out any other way passes through untouched, and if a load with the
#    diverter fails for whatever reason the file is loaded again the plain
#    way, so a file loads, or fails, exactly as it does without it. A table
#    loaded this way is overwritten by the next load: never switch this on
#    where two tables are held at once (merge, the command line).
#
# Measured on 2026-11-11: same tables, same query results. Re-apply this if
# audfprint is ever updated from upstream.
last_load = {}   # size, mtime_ns and verified (bool) of the file load_pkl() read last
_table_memory = {'on': False, 'buffer': None}
_DIVERT_MIN_SIZE = 16 << 20
_PICKLE_PROTO = 0x80
_PICKLE_FRAME = 0x95
_PICKLE_BYTEARRAY8 = 0x96
_PICKLE_NEXT_BUFFER = 0x97
# Other large items written outside the frames, passed through as they are:
# opcode -> bytes of its length field (BINBYTES, BINUNICODE, BINBYTES8,
# BINUNICODE8).
_PICKLE_LARGE = {0x42: 4, 0x58: 4, 0x8e: 8, 0x8d: 8}


# LOCAL MODIFICATION (2026-11-12, isal), not upstream audfprint.
#
# Inflating was what was left of a load: stock zlib takes about 1.2 s for a
# 404 MiB table (it copies a run of zeros byte by byte) and 0.5 s more to
# CRC32 it. isal (python -m pip install isal; Intel's ISA-L) does both in
# about 0.5 s. It is optional: where it is not installed, where FAST_INFLATE=off
# is set in .env, or where it fails the check below, everything loads with
# zlib exactly as before.
#
# What isal may decide is kept as small as can be. It inflates the bare
# deflate data; the CRC32 of what comes out has to match the member's trailer
# and so does the length, on every load (so with isal a "trusted" file is
# verified again all the same: that costs about 0.03 s). A load that ends in
# any error or any warning, or that meets a gzip header with optional fields
# other than the file name, is thrown away and done again by zlib with full
# verification, so whether and how a file fails is still zlib's answer alone.
# What isal hands over is therefore only ever data whose checksum and length
# are the ones the file was written with.
#
# Measured on 2026-11-12 on six real tables: same bytes; inflate + CRC32 in
# 0.35 to 0.58 s against 1.7 to 2.1 s with zlib. Re-apply this if audfprint
# is ever updated from upstream.
_fast = {'checked': False, 'module': None}


def _fast_inflate():
    """ isal's stand-in for the zlib module, or None when zlib is to be
        used. """
    if not _fast['checked']:
        module = None
        if (os.environ.get('FAST_INFLATE', '').strip().lower()
                not in ('off', '0', 'no', 'false', 'zlib')):
            try:
                from isal import isal_zlib
                # It has to give zlib's answers on this machine, used the
                # way _CheckedGzipReader uses it.
                sample = (bytes(bytearray(range(256))) * 64 + bytes(1 << 17)
                          + b'\x01\x00\x00\x00' * 4096 + bytes(1 << 17))
                packer = zlib.compressobj(6, zlib.DEFLATED, -zlib.MAX_WBITS)
                data = packer.compress(sample) + packer.flush() + b'trailer!'
                inflater = isal_zlib.decompressobj(-zlib.MAX_WBITS)
                pieces = []
                while not inflater.eof:
                    pieces.append(inflater.decompress(data, 1 << 15))
                    data = inflater.unconsumed_tail
                    if not data and not pieces[-1]:
                        break
                if (inflater.eof and b''.join(pieces) == sample
                        and inflater.unused_data == b'trailer!'
                        and isal_zlib.crc32(sample) == zlib.crc32(sample)
                        and isal_zlib.crc32(sample[5:], 77)
                        == zlib.crc32(sample[5:], 77)):
                    module = isal_zlib
            except Exception:
                module = None
        _fast['module'] = module
        _fast['checked'] = True
    return _fast['module']


def reuse_table_memory(on=True):
    """ Load every following table into the same memory. Only for a caller
        that never holds two tables at once: see the note above. """
    _table_memory['on'] = bool(on)
    if not on:
        _table_memory['buffer'] = None


def _gzip_header_length(data):
    """ Length of the gzip member header at the start of <data> (RFC 1952),
        or None when <data> does not hold all of it yet. Raises what zlib
        raises for a header it does not accept. """
    if len(data) < 10:
        return None
    if data[2] != 8:
        raise zlib.error('Error -3 while decompressing data: '
                         'unknown compression method')
    flags = data[3]
    if flags & 0xE0:
        raise zlib.error('Error -3 while decompressing data: '
                         'unknown header flags set')
    end = 10
    if flags & 4:
        # FEXTRA: a two-byte length and that many bytes.
        if len(data) < end + 2:
            return None
        end += 2 + data[end] + (data[end + 1] << 8)
    for flag in (8, 16):
        # FNAME, FCOMMENT: zero-terminated.
        if flags & flag:
            zero = data.find(b'\0', end)
            if zero < 0:
                return None
            end = zero + 1
    if flags & 2:
        # FHCRC: two bytes.
        end += 2
    return end if len(data) >= end else None


class _TableDiverter(io.RawIOBase):
    """ Raw stream of a pickle read from raw stream <raw>, unchanged except
        that the first large BYTEARRAY8 item between two frames is read
        into <memory>['buffer'] and replaced by NEXT_BUFFER. The unpickler
        gets the bytes as buffers=_handed_out(diverter.buffers).
    """

    def __init__(self, raw, memory):
        self._raw = raw
        self._memory = memory
        self._pending = b''     # bytes to hand out before reading on
        self._through = 0       # bytes of the current item still to pass on
        self._plain = False     # no longer looking at items: pass all on
        self._started = False
        self._diverted = False
        self.buffers = []

    def readable(self):
        return True

    def _read(self, count):
        """ The next <count> bytes of the pickle; fewer only at its end. """
        data = bytearray(count)
        got = 0
        with memoryview(data) as view:
            while got < count:
                more = self._raw.readinto(view[got:])
                if not more:
                    break
                got += more
        return bytes(data[:got])

    def _divert(self, count):
        buffer = self._memory['buffer']
        if buffer is None or len(buffer) < count:
            self._memory['buffer'] = buffer = None   # the old one goes first
            self._memory['buffer'] = buffer = bytearray(count)
        view = memoryview(buffer)[:count]
        got = 0
        while got < count:
            more = self._raw.readinto(view[got:])
            if not more:
                raise pickle.UnpicklingError('pickle data was truncated')
            got += more
        self.buffers.append(view)

    def _advance(self):
        """ Look at the item that starts here. """
        if not self._started:
            self._started = True
            self._pending = self._read(2)
            # Frames, and items outside them, come with protocol 4.
            if (len(self._pending) < 2 or self._pending[0] != _PICKLE_PROTO
                    or self._pending[1] < 4):
                self._plain = True
            return
        opcode = self._read(1)
        code = opcode[0] if opcode else None
        if code != _PICKLE_FRAME and code != _PICKLE_BYTEARRAY8 \
                and code not in _PICKLE_LARGE:
            # Not a layout this knows: the rest goes through as it is.
            self._pending = opcode
            self._plain = True
            return
        width = _PICKLE_LARGE.get(code, 8)
        size = self._read(width)
        if len(size) < width:
            self._pending = opcode + size
            self._plain = True
            return
        count = int.from_bytes(size, 'little')
        if (code == _PICKLE_BYTEARRAY8 and not self._diverted
                and count >= _DIVERT_MIN_SIZE):
            self._diverted = True
            self._divert(count)
            self._pending = bytes([_PICKLE_NEXT_BUFFER])
        else:
            self._pending = opcode + size
            self._through = count

    def readinto(self, buffer):
        with memoryview(buffer) as view, view.cast('B') as out:
            if not self._pending and not self._through and not self._plain:
                self._advance()
            if self._pending:
                count = min(len(out), len(self._pending))
                out[:count] = self._pending[:count]
                self._pending = self._pending[count:]
                return count
            if self._plain:
                return self._raw.readinto(out)
            count = self._raw.readinto(out[:min(len(out), self._through)])
            if not count:
                # The pickle ends inside this item.
                self._plain = True
                return 0
            self._through -= count
            return count


def _handed_out(buffers):
    """ The diverted buffers, one for each NEXT_BUFFER the unpickler meets. """
    while True:
        yield buffers.pop(0)


def _read_pklz(name, trusted, memory, preloaded=None, fast=None):
    """ The unpickled contents of .pklz file <name> and the reader's warning.
        trusted: (size, mtime_ns) of the file when its checksum was last
        verified, or None. memory: _table_memory to load the table into the
        kept buffer, or None.
        LOCAL MODIFICATION (2026-11-11, read ahead): preloaded is
        (the file's bytes, (size, mtime_ns) of the file they were read
        from), when the caller has read the file already (match_server.py
        reads the next file while it matches the current one), or None.
        LOCAL MODIFICATION (2026-11-12, isal): fast is what _fast_inflate()
        gave, or None for zlib. With it the checksum is verified whatever
        <trusted> says.
    """
    with (io.BytesIO(preloaded[0]) if preloaded is not None
          else open(name, 'rb', buffering=_DISK_READ_SIZE)) as f:
        if preloaded is not None:
            identity = (int(preloaded[1][0]), int(preloaded[1][1]))
        else:
            status = os.fstat(f.fileno())
            identity = (status.st_size, status.st_mtime_ns)
        verify = True
        if trusted is not None and fast is None:
            try:
                verify = (int(trusted[0]), int(trusted[1])) != identity
            except (TypeError, ValueError, IndexError):
                verify = True
        reader = _CheckedGzipReader(f, verify, fast)
        if memory is None:
            temp = _load_pklz_pickle(
                io.BufferedReader(reader, _GZIP_INFLATE_SIZE))
        else:
            diverter = _TableDiverter(reader, memory)
            temp = _load_pklz_pickle(
                io.BufferedReader(diverter, _GZIP_INFLATE_SIZE),
                buffers=_handed_out(diverter.buffers))
        # Check the rest of the file too, not just the part pickle
        # needed.
        warning = reader.finish()
    last_load.clear()
    last_load.update(size=identity[0], mtime_ns=identity[1],
                     verified=bool(verify and not warning),
                     inflate='zlib' if fast is None else 'isal')
    return temp, warning


class _CheckedGzipReader(io.RawIOBase):
    """ Raw stream of the decompressed contents of gzip file object
        <fileobj>, inflated directly into the buffer readinto() is given.
        finish() inflates and checks whatever the reads left.
    """

    def __init__(self, fileobj, verify=True, fast=None):
        self._fileobj = fileobj
        # verify=False: see _gzip_header_length().
        self._verify = verify
        # fast: see _fast_inflate(). Header and trailer are then read here,
        # as for verify=False, and the CRC32 is checked here as well.
        self._fast = fast
        self._crc = 0
        self._member_size = 0
        self._inflater = None
        self._input = b''
        self._finished = False
        # Set when the data ends early: the error for a read that wants
        # more, and the warning finish() returns instead.
        self._early_end = None
        self._warning = None

    def readable(self):
        return True

    def _start_member(self):
        """ Set up the inflater for the next member; False if there is none.
        """
        if self._inflater is not None:
            rest = self._inflater.unused_data
            if self._fast is not None or not self._verify:
                # The member's trailer, which zlib reads itself when it
                # verifies: CRC32, then the length modulo 2^32.
                while len(rest) < 8:
                    more = self._fileobj.read(_GZIP_READ_SIZE)
                    if not more:
                        break
                    rest += more
                if len(rest) < 8:
                    # As when zlib waits for the rest of a trailer.
                    self._early_end = (EOFError, 'Compressed file ended before '
                                       'the end-of-stream marker was reached')
                    self._warning = ('gzip trailer incomplete, checksum not '
                                     'verified')
                    return False
                if (self._fast is not None
                        and int.from_bytes(rest[:4], 'little') != self._crc):
                    raise zlib.error('Error -3 while decompressing data: '
                                     'incorrect data check')
                if (int.from_bytes(rest[4:8], 'little')
                        != self._member_size & 0xFFFFFFFF):
                    raise zlib.error('Error -3 while decompressing data: '
                                     'incorrect length check')
                rest = rest[8:]
            # Zero padding after a member is allowed, as in gzip.open().
            self._input = rest.lstrip(b'\0')
            while not self._input:
                more = self._fileobj.read(_GZIP_READ_SIZE)
                if not more:
                    return False
                self._input = more.lstrip(b'\0')
        while len(self._input) < 2:
            more = self._fileobj.read(_GZIP_READ_SIZE)
            if not more:
                break
            self._input += more
        if not self._input:
            # An empty file: pickle reports that it ran out of input.
            return False
        if self._input[:2] != b'\037\213':
            message = 'Not a gzipped file (%r)' % self._input[:2]
            if self._inflater is None:
                raise gzip.BadGzipFile(message)
            # Something else after a member that checked out: the data ends
            # with that member, and the rest of the file is not read.
            start = self._fileobj.tell() - len(self._input)
            ignored = self._fileobj.seek(0, io.SEEK_END) - start
            self._early_end = (gzip.BadGzipFile, message)
            self._warning = ('%d unexpected bytes after the compressed data, '
                             'ignored' % ignored)
            return False
        if self._verify and self._fast is None:
            # 16 + MAX_WBITS: a gzip member, whose CRC32 and length zlib
            # checks.
            self._inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
            return True
        # Not verifying: step over the member's header and inflate the bare
        # deflate data, which zlib then does not checksum.
        while True:
            header = _gzip_header_length(self._input)
            if header is not None:
                break
            more = self._fileobj.read(_GZIP_READ_SIZE)
            if not more:
                # The file ends inside the header.
                self._input = b''
                self._early_end = (EOFError, 'Compressed file ended before '
                                   'the end-of-stream marker was reached')
                self._warning = ('gzip trailer incomplete, checksum not '
                                 'verified')
                return False
            self._input += more
        if self._fast is not None and self._input[3] & ~8:
            # Optional header fields (zlib checks a header CRC, for one) are
            # left to zlib; gzip.open() only ever writes the file name.
            raise zlib.error('gzip header with optional fields')
        self._input = self._input[header:]
        self._inflater = (self._fast or zlib).decompressobj(-zlib.MAX_WBITS)
        self._member_size = 0
        self._crc = 0
        return True

    def _inflate(self, out):
        """ Fill memoryview <out> as far as the data goes; returns the count.
        """
        size = len(out)
        filled = 0
        while filled < size and not self._finished:
            if self._inflater is None or self._inflater.eof:
                if not self._start_member():
                    self._finished = True
                    break
            data = self._input or self._fileobj.read(_GZIP_READ_SIZE)
            # Bounded output keeps the pieces small, so memory stays at
            # the table plus a little and the copies stay in the cache.
            piece = self._inflater.decompress(
                data, min(size - filled, _GZIP_INFLATE_SIZE))
            self._input = self._inflater.unconsumed_tail
            if self._fast is not None:
                self._crc = self._fast.crc32(piece, self._crc)
            out[filled:filled + len(piece)] = piece
            filled += len(piece)
            self._member_size += len(piece)
            if not data and not piece and not self._inflater.eof:
                # Nothing left to read and nothing held back by zlib: the
                # file ends inside this member.
                self._finished = True
                self._early_end = (EOFError, 'Compressed file ended before '
                                   'the end-of-stream marker was reached')
                self._warning = ('gzip trailer incomplete, checksum not '
                                 'verified')
        return filled

    def readinto(self, buffer):
        with memoryview(buffer) as view, view.cast('B') as out:
            size = len(out)
            filled = self._inflate(out)
        # What is there is returned first, and only a read that wants more
        # fails: pickle does not need what comes after its last opcode.
        if size and not filled and self._early_end is not None:
            error, message = self._early_end
            raise error(message)
        return filled

    def finish(self):
        """ Inflate and check whatever the reads did not need. Returns
            None, or the warning if the data ended early.
        """
        with memoryview(bytearray(_GZIP_INFLATE_SIZE)) as scratch:
            while self._inflate(scratch):
                pass
        return self._warning


class HashTable(object):
    """
    Simple hash table for storing and retrieving fingerprint hashes.

    :usage:
       >>> ht = HashTable(size=2**10, depth=100)
       >>> ht.store('identifier', list_of_landmark_time_hash_pairs)
       >>> list_of_ids_tracks = ht.get_hits(hash)
    """

    def __init__(self, filename=None, hashbits=20, depth=100, maxtime=16384,
                 trusted=None, preloaded=None):
        """ allocate an empty hash table of the specified size
            trusted, preloaded: see _read_pklz() """
        if filename is not None:
            self.load(filename, trusted, preloaded)
        else:
            self.hashbits = hashbits
            self.depth = depth
            self.maxtimebits = _bitsfor(maxtime)
            # allocate the big table
            size = 2 ** hashbits
            self.table = np.zeros((size, depth), dtype=np.uint32)
            # keep track of number of entries in each list
            self.counts = np.zeros(size, dtype=np.int32)
            # map names to IDs
            self.names = []
            # track number of hashes stored per id
            self.hashesperid = np.zeros(0, np.uint32)
            # Empty params
            self.params = {}
            # Record the current version
            self.ht_version = HT_VERSION
            # Mark as unsaved
            self.dirty = True

    def reset(self):
        """ Reset to empty state (but preserve parameters) """
        self.table[:, :] = 0
        self.counts[:] = 0
        self.names = []
        self.hashesperid.resize(0)
        self.dirty = True

    def store(self, name, timehashpairs):
        """ Store a list of hashes in the hash table
            associated with a particular name (or integer ID) and time.
        """
        id_ = self.name_to_id(name, add_if_missing=True)
        # Now insert the hashes
        hashmask = (1 << self.hashbits) - 1
        # mxtime = self.maxtime
        maxtime = 1 << self.maxtimebits
        timemask = maxtime - 1
        # Try sorting the pairs by hash value, for better locality in storing
        # sortedpairs = sorted(timehashpairs, key=lambda x:x[1])
        sortedpairs = timehashpairs
        # Tried making it an np array to permit vectorization, but slower...
        # sortedpairs = np.array(sorted(timehashpairs, key=lambda x:x[1]),
        #                       dtype=int)
        # Keep only the bottom part of the time value
        # sortedpairs[:,0] = sortedpairs[:,0] % self.maxtime
        # Keep only the bottom part of the hash value
        # sortedpairs[:,1] = sortedpairs[:,1] & hashmask
        # The id value is based on (id_ + 1) to avoid an all-zero value.
        idval = (id_ + 1) << self.maxtimebits
        for time_, hash_ in sortedpairs:
            # Keep only the bottom part of the hash value
            hash_ &= hashmask
            # How many already stored for this hash?
            count = self.counts[hash_]
            # Keep only the bottom part of the time value
            # time_ %= mxtime
            time_ &= timemask
            # Mixin with ID
            val = (idval + time_)  # .astype(np.uint32)
            if count < self.depth:
                # insert new val in next empty slot
                # slot = self.counts[hash_]
                self.table[hash_, count] = val
            else:
                # Choose a point at random
                slot = random.randint(0, count)
                # Only store if random slot wasn't beyond end
                if slot < self.depth:
                    self.table[hash_, slot] = val
            # Update record of number of vals in this bucket
            self.counts[hash_] = count + 1
        # Record how many hashes we (attempted to) save for this id
        self.hashesperid[id_] += len(timehashpairs)
        # Mark as unsaved
        self.dirty = True

    def get_entry(self, hash_):
        """ Return np.array of [id, time] entries
            associate with the given hash as rows.
        """
        vals = self.table[hash_, :min(self.depth, self.counts[hash_])]
        maxtimemask = (1 << self.matimebits) - 1
        # ids we report externally start at 0, but in table they start at 1.
        ids = (vals >> self.maxtimebits) - 1
        return np.c_[ids, vals & maxtimemask].astype(np.int32)

    def get_hits(self, hashes):
        """ Return np.array of [id, delta_time, hash, time] rows
            associated with each element in hashes array of [time, hash] rows.

            LOCAL MODIFICATION (not upstream audfprint): an entry that a
            bucket holds more than once is returned once. Adding the same
            file to a table again stores every one of its (track, time)
            entries again, and the default match counting counted each copy:
            a table holding a track 11 times turned 3 chance hashes into
            "33 aligned", which is what made
            numerophobe-pklzs/.../LEGACY/aornightdrive-A-Cl.-01092024-old.pklz
            report PROBABLE matches for every query on 2026-11-04. Tables
            without repeated entries give exactly the same hits as before.
            Vectorised over the query hashes instead of a Python loop.

            LOCAL MODIFICATION (2026-11-11, scan speed): only the slots
            a bucket really uses are fetched. A bucket has room for <depth>
            (100) entries and a typical table fills about 8 of them, so
            fetching, blanking and sorting whole buckets was mostly work on
            empty slots: get_hits() was more than half of the matching time.
            Now the used slots of all query hashes are gathered into one flat
            array and sorted once by (query row, value). The rows returned are
            the same, in the same order: by query hash as given, and within a
            bucket by ascending value, repeated values once, zeros never.

            Re-apply this if audfprint is ever updated from upstream.
        """
        hashes = np.asarray(hashes)
        if hashes.ndim != 2 or hashes.shape[0] == 0:
            return np.zeros((0, 4), np.int32)
        if self.table.dtype != np.uint32:
            # The sort key below packs a value into 32 bits.
            return self._get_hits_whole_buckets(hashes)
        maxtimemask = (1 << self.maxtimebits) - 1
        hashmask = (1 << self.hashbits) - 1
        q_times = hashes[:, 0].astype(np.int64)
        q_hashes = hashes[:, 1].astype(np.int64) & hashmask
        # Slots in use per query hash; a negative count is an empty bucket,
        # as it was when whole buckets were blanked from the count on.
        nids = np.minimum(self.depth, self.counts[q_hashes]).astype(np.int64)
        np.maximum(nids, 0, out=nids)
        total = int(nids.sum())
        if total == 0:
            return np.empty((0, 4), np.int32)
        # One element per used slot: its query row and its slot number.
        rows = np.repeat(np.arange(len(nids), dtype=np.int64), nids)
        cols = np.arange(total, dtype=np.int64)
        cols -= np.repeat(np.cumsum(nids) - nids, nids)
        key = self.table[q_hashes[rows], cols].astype(np.int64)
        # Sorted by (row, value): rows stay in query order, a bucket's values
        # ascend, and a repeated entry sits next to its first copy.
        key |= rows << 32
        key.sort()
        keep = np.empty(total, bool)
        keep[0] = True
        np.not_equal(key[1:], key[:-1], out=keep[1:])
        tabvals = key & 0xFFFFFFFF
        # Stored values are never 0 (the id is offset by one); a 0 inside the
        # used part of a bucket was dropped before as well.
        keep &= tabvals != 0
        rows = (key >> 32)[keep]
        tabvals = tabvals[keep]
        hits = np.empty((len(rows), 4), np.int32)
        # Make external IDs start from 0.
        hits[:, 0] = (tabvals >> self.maxtimebits) - 1
        hits[:, 1] = (tabvals & maxtimemask) - q_times[rows]
        hits[:, 2] = q_hashes[rows]
        hits[:, 3] = q_times[rows]
        return hits

    def _get_hits_whole_buckets(self, hashes):
        """ get_hits() as it was until 2026-11-11: every bucket is taken
            whole (all <depth> slots), blanked beyond its count and sorted.
            Kept for tables whose entries are not uint32, where the packed
            sort key of get_hits() would not hold a value.
        """
        hashes = np.asarray(hashes)
        if hashes.ndim != 2 or hashes.shape[0] == 0:
            return np.zeros((0, 4), np.int32)
        maxtimemask = (1 << self.maxtimebits) - 1
        hashmask = (1 << self.hashbits) - 1
        q_times = hashes[:, 0].astype(np.int64)
        q_hashes = hashes[:, 1].astype(np.int64) & hashmask
        nids = np.minimum(self.depth, self.counts[q_hashes])
        # One row of bucket entries per query hash, unused slots blanked.
        vals = self.table[q_hashes]
        vals[np.arange(self.depth)[np.newaxis, :] >= nids[:, np.newaxis]] = 0
        # Sorted, a repeated entry sits next to its first copy. Stored
        # values are never 0 (the id is offset by one), so 0 is free space.
        vals.sort(axis=1)
        keep = vals != 0
        keep[:, 1:] &= vals[:, 1:] != vals[:, :-1]
        rows, cols = np.nonzero(keep)
        tabvals = vals[rows, cols].astype(np.int64)
        hits = np.empty((len(rows), 4), np.int32)
        # Make external IDs start from 0.
        hits[:, 0] = (tabvals >> self.maxtimebits) - 1
        hits[:, 1] = (tabvals & maxtimemask) - q_times[rows]
        hits[:, 2] = q_hashes[rows]
        hits[:, 3] = q_times[rows]
        return hits

    def save(self, name, params=None, file_object=None):
        """ Save hash table to file <name>,
            including optional addition params
        """
        # Merge in any provided params
        if params:
            for key in params:
                self.params[key] = params[key]
        if file_object:
            f = file_object
        else:
            f = gzip.open(name, 'wb')
        pickle.dump(self, f, pickle.HIGHEST_PROTOCOL)
        self.dirty = False
        nhashes = sum(self.counts)
        # Report the proportion of dropped hashes (overfull table)
        dropped = nhashes - sum(np.minimum(self.depth, self.counts))
        print("Saved fprints for", sum(n is not None for n in self.names),
              "files (", nhashes, "hashes) to", name,
              "(%.2f%% dropped)" % (100.0 * dropped / max(1, nhashes)))

    def load(self, name, trusted=None, preloaded=None):
        """ Read either pklz or mat-format hash table file """
        ext = os.path.splitext(name)[1]
        last_load.clear()
        if ext == '.mat':
            self.load_matlab(name)
        else:
            self.load_pkl(name, trusted=trusted, preloaded=preloaded)
        # LOCAL MODIFICATION: numpy sums, see _CheckedGzipReader.
        nhashes = np.sum(self.counts, dtype=np.int64)
        # Report the proportion of dropped hashes (overfull table)
        dropped = nhashes - np.sum(np.minimum(self.depth, self.counts),
                                   dtype=np.int64)
        print("Read fprints for", sum(n is not None for n in self.names),
              "files (", nhashes, "hashes) from", name,
              "(%.2f%% dropped)" % (100.0 * dropped / max(1, nhashes)))

    def load_pkl(self, name, file_object=None, trusted=None, preloaded=None):
        """ Read hash table values from pickle file <name>. """
        if file_object:
            f = file_object
            temp = _load_pklz_pickle(f)
        else:
            # LOCAL MODIFICATION: see _CheckedGzipReader, _DISK_READ_SIZE
            # and _read_pklz().
            memory = _table_memory if _table_memory['on'] else None
            fast = _fast_inflate()
            try:
                temp, warning = _read_pklz(name, trusted, memory, preloaded,
                                           fast)
                if warning and fast is not None:
                    # Anything out of the ordinary is zlib's to judge.
                    raise ValueError(warning)
            except Exception:
                if memory is None and fast is None:
                    raise
                # However it went wrong, the plain way has the last word:
                # zlib, and after isal with the checksum verified.
                temp = None
                temp, warning = _read_pklz(
                    name, None if fast is not None else trusted, None,
                    preloaded)
            if warning:
                print('warning: %s: %s' % (name, warning), file=sys.stderr)
        if temp.ht_version < HT_OLD_COMPAT_VERSION:
            raise ValueError('Version of ' + name + ' is ' + str(temp.ht_version)
                             + ' which is not at least ' +
                             str(HT_OLD_COMPAT_VERSION))
        # assert temp.ht_version >= HT_COMPAT_VERSION
        params = temp.params
        self.hashbits = temp.hashbits
        self.depth = temp.depth
        if hasattr(temp, 'maxtimebits'):
            self.maxtimebits = temp.maxtimebits
        else:
            self.maxtimebits = _bitsfor(temp.maxtime)
        if temp.ht_version < HT_COMPAT_VERSION:
            # Need to upgrade the database.
            print("Loading database version", temp.ht_version,
                  "in compatibility mode.")
            # Offset all the nonzero bins with one ID count.
            temp.table += np.array(1 << self.maxtimebits).astype(np.uint32) * (
                    temp.table != 0)
            temp.ht_version = HT_VERSION
        self.table = temp.table
        self.ht_version = temp.ht_version
        self.counts = temp.counts
        self.names = temp.names
        self.hashesperid = np.array(temp.hashesperid).astype(np.uint32)
        self.dirty = False
        self.params = params

    def load_matlab(self, name):
        """ Read hash table from version saved by Matlab audfprint.
        :params:
          name : str
            filename of .mat matlab fp dbase file
        :side_effects:
          Sets up attributes of self including
          params : dict
            dictionary of parameters from the Matlab file including
              'mat_version' : float
                version read from Matlab file (must be >= 0.90)
              'hoptime' : float
                hoptime read from Matlab file (must be 0.02322)
              'targetsr' : float
                target sampling rate from Matlab file (must be 11025)
        """
        mht = scipy.io.loadmat(name)
        params = {}
        params['mat_version'] = mht['HT_params'][0][0][-1][0][0]
        assert params['mat_version'] >= 0.9
        self.hashbits = _bitsfor(mht['HT_params'][0][0][0][0][0])
        self.depth = mht['HT_params'][0][0][1][0][0]
        self.maxtimebits = _bitsfor(mht['HT_params'][0][0][2][0][0])
        params['hoptime'] = mht['HT_params'][0][0][3][0][0]
        params['targetsr'] = mht['HT_params'][0][0][4][0][0]
        params['nojenkins'] = mht['HT_params'][0][0][5][0][0]
        # Python doesn't support the (pointless?) jenkins hashing
        assert params['nojenkins']
        self.table = mht['HashTable'].T
        self.counts = mht['HashTableCounts'][0]
        self.names = [str(val[0]) if len(val) > 0 else []
                      for val in mht['HashTableNames'][0]]
        self.hashesperid = np.array(mht['HashTableLengths'][0]).astype(np.uint32)
        # Matlab uses 1-origin for the IDs in the hashes, but the Python code
        # also skips using id_ 0, so that names[0] corresponds to id_ 1.
        # Otherwise unmodified database
        self.dirty = False
        self.params = params

    def totalhashes(self):
        """ Return the total count of hashes stored in the table """
        return np.sum(self.counts)

    def merge(self, ht):
        """ Merge in the results from another hash table """
        # All the items go into our table, offset by our current size
        # Check compatibility
        assert self.maxtimebits == ht.maxtimebits
        ncurrent = len(self.names)
        # size = len(self.counts)
        self.names += ht.names
        self.hashesperid = np.append(self.hashesperid, ht.hashesperid)
        # Shift all the IDs in the second table down by ncurrent
        idoffset = (1 << self.maxtimebits) * ncurrent
        for hash_ in np.nonzero(ht.counts)[0]:
            allvals = np.r_[self.table[hash_, :self.counts[hash_]],
                            ht.table[hash_, :ht.counts[hash_]] + idoffset]
            # ht.counts[hash_] may be more than the actual number of
            # hashes we obtained, if ht.counts[hash_] > ht.depth.
            # Subselect based on actual size.
            if len(allvals) > self.depth:
                # Our hash bin is filled: randomly subselect the
                # hashes, and update count to accurately track the
                # total number of hashes we've seen for this bin.
                somevals = np.random.permutation(allvals)[:self.depth]
                self.table[hash_,] = somevals
                self.counts[hash_] += ht.counts[hash_]
            else:
                # Our bin isn't full.  Store all the hashes, and
                # accurately track how many values it contains.  This
                # may mean some of the hashes counted for full buckets
                # in ht are "forgotten" if ht.depth < self.depth.
                self.table[hash_, :len(allvals)] = allvals
                self.counts[hash_] = len(allvals)

        self.dirty = True

    def name_to_id(self, name, add_if_missing=False):
        """ Lookup name in the names list, or optionally add. """
        if isinstance(name, basestring):
            # lookup name or assign new
            if name not in self.names:
                if not add_if_missing:
                    raise ValueError("name " + name + " not found")
                # Use an empty slot in the list if one exists.
                try:
                    id_ = self.names.index(None)
                    self.names[id_] = name
                    self.hashesperid[id_] = 0
                except ValueError:
                    self.names.append(name)
                    self.hashesperid = np.append(self.hashesperid, [0])
            id_ = self.names.index(name)
        else:
            # we were passed in a numerical id
            id_ = name
        return id_

    def remove(self, name):
        """ Remove all data for named entity from the hash table. """
        id_ = self.name_to_id(name)
        # Top nybbles of table entries are id_ + 1 (to avoid all-zero entries)
        id_in_table = (self.table >> self.maxtimebits) == id_ + 1
        hashes_removed = 0
        for hash_ in np.nonzero(np.max(id_in_table, axis=1))[0]:
            vals = self.table[hash_, :self.counts[hash_]]
            vals = [v for v, x in zip(vals, id_in_table[hash_])
                    if not x]
            self.table[hash_] = np.hstack([vals,
                                           np.zeros(self.depth - len(vals))])
            # This will forget how many extra hashes we had dropped until now.
            self.counts[hash_] = len(vals)
            hashes_removed += np.sum(id_in_table[hash_])
        self.names[id_] = None
        self.hashesperid[id_] = 0
        self.dirty = True
        print("Removed", name, "(", hashes_removed, "hashes).")

    def retrieve(self, name):
        """Return an np.array of (time, hash) pairs found in the table."""
        id_ = self.name_to_id(name)
        maxtimemask = (1 << self.maxtimebits) - 1
        num_hashes_per_hash = np.sum(
                (self.table >> self.maxtimebits) == (id_ + 1), axis=1)
        hashes_containing_id = np.nonzero(num_hashes_per_hash)[0]
        timehashpairs = np.zeros((sum(num_hashes_per_hash), 2), dtype=np.int32)
        hashes_so_far = 0
        for hash_ in hashes_containing_id:
            entries = self.table[hash_, :self.counts[hash_]]
            matching_entries = np.nonzero(
                    (entries >> self.maxtimebits) == (id_ + 1))[0]
            times = (entries[matching_entries] & maxtimemask)
            timehashpairs[hashes_so_far: hashes_so_far + len(times), 0] = times
            timehashpairs[hashes_so_far: hashes_so_far + len(times), 1] = hash_
            hashes_so_far += len(times)
        return timehashpairs

    def list(self, print_fn=None):
        """ List all the known items. """
        if not print_fn:
            print_fn = print
        for name, count in zip(self.names, self.hashesperid):
            if name:
                print_fn(name + " (" + str(count) + " hashes)")
