(function () {
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const statusEl = document.getElementById('status');

  const leftFileInput = document.getElementById('left-file-input');
  const leftDropZone = document.getElementById('left-drop-zone');
  const rightFileInput = document.getElementById('right-file-input');
  const rightDropZone = document.getElementById('right-drop-zone');

  let currentFileBaseName = 'wiggle';
  let trackedObjectUrls = [];
  let pendingLeftFile = null;
  let pendingRightFile = null;

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', !!isError);
  }

  function revokeTrackedUrls() {
    trackedObjectUrls.forEach(URL.revokeObjectURL);
    trackedObjectUrls = [];
  }

  function trackObjectUrl(url) {
    trackedObjectUrls.push(url);
  }

  window.AppShared = { setStatus, trackObjectUrl };

  // Walks JPEG marker segments from an SOI to find the true matching EOI.
  // A naive scan for the next 0xFFD9 byte pair is unsafe: the Exif (APP1)
  // segment commonly embeds its own small preview JPEG, complete with a
  // nested SOI/EOI pair, before the real end of the full-size image. Reading
  // each segment's declared length lets us skip straight over that embedded
  // thumbnail without ever mistaking its markers for the real ones.
  function findImageEnd(bytes, start) {
    let offset = start + 2; // past the SOI marker itself
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 0xFF) {
        offset++;
        continue;
      }
      while (bytes[offset + 1] === 0xFF) offset++; // legal fill bytes
      const marker = bytes[offset + 1];
      offset += 2;

      if (marker === 0xD9) {
        return offset; // EOI
      }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        continue; // TEM / restart markers carry no length
      }
      if (marker === 0xDA) {
        // SOS: skip its header, then scan entropy-coded data for the next
        // real marker (stuffed 0xFF00 bytes and restart markers are data).
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        offset += length;
        while (offset < bytes.length - 1) {
          if (bytes[offset] === 0xFF) {
            const next = bytes[offset + 1];
            if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) {
              offset += 2;
              continue;
            }
            break;
          }
          offset++;
        }
        continue;
      }
      // Generic APPn/DQT/DHT/SOF/COM/etc segment: skip it via its length.
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      offset += length;
    }
    return bytes.length; // ran off the end without a clean EOI
  }

  function splitMpoImages(buffer) {
    const bytes = new Uint8Array(buffer);
    const images = [];
    let offset = 0;
    while (offset < bytes.length - 1 && images.length < 2) {
      if (bytes[offset] !== 0xFF || bytes[offset + 1] !== 0xD8) {
        offset++; // skip padding between images
        continue;
      }
      const start = offset;
      const end = findImageEnd(bytes, offset);
      images.push(bytes.subarray(start, end));
      offset = end;
    }
    return images;
  }

  function loadImageFromBytes(bytes) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      trackObjectUrl(url);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode an extracted frame as a JPEG image.'));
      img.src = url;
    });
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      trackObjectUrl(url);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not decode "${file.name}" as a JPEG image.`));
      img.src = url;
    });
  }

  function beginNewLoad(baseName) {
    window.Editor.reset();
    revokeTrackedUrls();
    currentFileBaseName = baseName;
  }

  function finishLoadingFrames(imgLeft, imgRight) {
    window.Editor.load(imgLeft, imgRight, currentFileBaseName);
    setStatus('Ready — align, crop, and adjust below, then generate the GIF.');
  }

  function setDualBoxFile(zoneEl, nameEl, file) {
    zoneEl.classList.toggle('has-file', !!file);
    nameEl.textContent = file ? file.name : '';
  }

  function resetDualBoxes() {
    pendingLeftFile = null;
    pendingRightFile = null;
    leftFileInput.value = '';
    rightFileInput.value = '';
    setDualBoxFile(leftDropZone, leftDropZone.querySelector('.file-name'), null);
    setDualBoxFile(rightDropZone, rightDropZone.querySelector('.file-name'), null);
  }

  async function handleFile(file) {
    resetDualBoxes();
    beginNewLoad(file.name.replace(/\.[^.]+$/, '') || 'wiggle');

    fileInput.disabled = true;
    setStatus('Reading file…');

    try {
      const buffer = await file.arrayBuffer();
      const frames = splitMpoImages(buffer);
      if (frames.length < 2) {
        setStatus('This file only contains one image — is it really an MPO from the W3?', true);
        return;
      }

      setStatus('Decoding frames…');
      const [imgLeft, imgRight] = await Promise.all([
        loadImageFromBytes(frames[0]),
        loadImageFromBytes(frames[1]),
      ]);

      finishLoadingFrames(imgLeft, imgRight);
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Something went wrong reading that file.', true);
    } finally {
      fileInput.disabled = false;
    }
  }

  async function handleTwoFiles(leftFile, rightFile) {
    fileInput.value = '';
    beginNewLoad(leftFile.name.replace(/\.[^.]+$/, '') || 'wiggle');

    setStatus('Decoding frames…');
    try {
      const [imgLeft, imgRight] = await Promise.all([
        loadImageFromFile(leftFile),
        loadImageFromFile(rightFile),
      ]);
      finishLoadingFrames(imgLeft, imgRight);
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Something went wrong reading those files.', true);
    }
  }

  function wireDropZone(zoneEl, inputEl, onFile) {
    inputEl.addEventListener('change', () => {
      if (inputEl.files[0]) onFile(inputEl.files[0]);
    });
    ['dragenter', 'dragover'].forEach((evt) =>
      zoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        zoneEl.classList.add('dragover');
      })
    );
    ['dragleave', 'dragend'].forEach((evt) =>
      zoneEl.addEventListener(evt, () => zoneEl.classList.remove('dragover'))
    );
    zoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      zoneEl.classList.remove('dragover');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  wireDropZone(dropZone, fileInput, handleFile);

  wireDropZone(leftDropZone, leftFileInput, (file) => {
    pendingLeftFile = file;
    setDualBoxFile(leftDropZone, leftDropZone.querySelector('.file-name'), file);
    if (pendingRightFile) handleTwoFiles(pendingLeftFile, pendingRightFile);
  });

  wireDropZone(rightDropZone, rightFileInput, (file) => {
    pendingRightFile = file;
    setDualBoxFile(rightDropZone, rightDropZone.querySelector('.file-name'), file);
    if (pendingLeftFile) handleTwoFiles(pendingLeftFile, pendingRightFile);
  });
})();
