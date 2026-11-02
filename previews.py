"""On-demand Office-to-PDF previews, isolated from request threads and original files."""
import hashlib
import logging
import os
import shutil
import signal
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pymupdf as fitz

OFFICE_FORMATS = {
    '.doc', '.dot', '.docx', '.docm', '.dotx', '.dotm',
    '.xls', '.xlt', '.xlsx', '.xlsm', '.xltx', '.xltm',
    '.ppt', '.pps', '.pot', '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm',
    '.odt', '.ods', '.odp', '.odg', '.ott', '.ots', '.otp', '.rtf',
}
log = logging.getLogger('doggs.previews')


class OfficePreviews:
    def __init__(self, cache_dir, executable=None, timeout=90, max_pending=4):
        self.cache_dir = Path(cache_dir).resolve()
        local = Path(__file__).resolve().parent / '.office' / 'soffice'
        self.executable = executable or os.getenv('LIBREOFFICE_BIN') or shutil.which('libreoffice') or shutil.which('soffice') or (str(local) if local.is_file() else None)
        self.timeout, self.max_pending = timeout, max_pending
        self.lock = threading.Lock()
        self.jobs = {}
        self.generation = 0
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='office-preview')

    def cache_path(self, path):
        path = Path(path).resolve()
        stat = path.stat()
        key = hashlib.sha256(f'1:{path}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}'.encode()).hexdigest()
        return self.cache_dir / (key + '.pdf')

    def cached(self, path):
        output = self.cache_path(path)
        return output if output.is_file() else None

    def request(self, path):
        path = Path(path).resolve()
        output = self.cache_path(path)
        if output.is_file(): return 'ready', output
        if path.suffix.lower() not in OFFICE_FORMATS or not self.executable: return 'unavailable', None
        key = output.stem
        with self.lock:
            if self.jobs.get(key) == 'ready': self.jobs.pop(key)
            if key in self.jobs: return self.jobs[key], None
            if sum(state in {'queued', 'rendering'} for state in self.jobs.values()) >= self.max_pending:
                return 'busy', None
            # Keep completed/failing job bookkeeping bounded. PDFs remain cached on disk.
            if len(self.jobs) >= 128:
                self.jobs = {key: state for key, state in self.jobs.items() if state in {'queued', 'rendering'}}
            self.jobs[key] = 'queued'
            self.worker.submit(self._convert, path, output)
        return 'queued', None

    def _convert(self, path, output):
        with self.lock: self.jobs[output.stem] = 'rendering'
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.office-', dir=self.cache_dir) as work:
                work = Path(work)
                source = work / ('document' + path.suffix.lower())
                shutil.copy2(path, source)
                profile = work / 'profile'
                # Use a private profile; documents cannot inherit enabled user macros.
                user = profile / 'user'
                user.mkdir(parents=True)
                (user / 'registrymodifications.xcu').write_text(
                    '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
                    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
                    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
                    '</item></oor:items>', encoding='utf-8')
                command = [self.executable, f'-env:UserInstallation={profile.as_uri()}',
                           '--headless', '--nologo', '--nodefault', '--norestore',
                           '--convert-to', 'pdf', '--outdir', str(work), str(source)]
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    process.communicate(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.communicate()
                    raise TimeoutError('Office preview conversion timed out')
                converted = work / 'document.pdf'
                if process.returncode or not converted.is_file(): raise ValueError('Office preview conversion failed')
                with fitz.open(converted) as document:
                    if not len(document) or document.needs_pass: raise ValueError('No readable pages in converted PDF')
                # Discard output if the source changed during conversion.
                if self.cache_path(path) != output: raise ValueError('Document changed during conversion')
                converted.replace(output)
            with self.lock:
                self.jobs[output.stem] = 'ready'
                self.generation += 1
        except Exception as error:
            log.warning('Could not create %s preview: %s', path.suffix.lower(), error)
            with self.lock: self.jobs[output.stem] = 'failed'
