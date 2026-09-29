(function () {
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const fpsSlider = document.getElementById('fps-slider');
  const fpsLabel = document.getElementById('fps-label');
  const statusEl = document.getElementById('status');
  const previewsEl = document.getElementById('previews');
  const previewLeft = document.getElementById('preview-left');
  const previewRight = document.getElementById('preview-right');
  const outputEl = document.getElementById('output');
  const outputGif = document.getElementById('output-gif');
  const downloadLink = document.getElementById('download-link');

  let currentImages = null; // [Image, Image]
  let currentFileBaseName = 'wiggle';
  let trackedObjectUrls = [];

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', !!isError);
  }

  function revokeTrackedUrls() {
    trackedObjectUrls.forEach(URL.revokeObjectURL);
    trackedObjectUrls = [];
  }

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
      trackedObjectUrls.push(url);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode an extracted frame as a JPEG image.'));
      img.src = url;
    });
  }

  function renderGif() {
    if (!currentImages) return Promise.resolve();
    const [imgLeft, imgRight] = currentImages;
    const fps = Number(fpsSlider.value);
    const delay = Math.round(1000 / fps);

    setStatus('Encoding GIF…');

    const canvas = document.createElement('canvas');
    canvas.width = imgLeft.naturalWidth;
    canvas.height = imgLeft.naturalHeight;
    const ctx = canvas.getContext('2d');

    const gif = new GIF({
      workers: 2,
      quality: 10,
      workerScript: 'lib/gif.worker.js',
      width: canvas.width,
      height: canvas.height,
    });

    ctx.drawImage(imgLeft, 0, 0, canvas.width, canvas.height);
    gif.addFrame(canvas, { copy: true, delay });
    ctx.drawImage(imgRight, 0, 0, canvas.width, canvas.height);
    gif.addFrame(canvas, { copy: true, delay });

    return new Promise((resolve) => {
      gif.on('progress', (p) => setStatus(`Encoding GIF… ${Math.round(p * 100)}%`));
      gif.on('finished', (blob) => {
        const url = URL.createObjectURL(blob);
        trackedObjectUrls.push(url);
        outputGif.src = url;
        downloadLink.href = url;
        downloadLink.download = `${currentFileBaseName}.gif`;
        outputEl.hidden = false;
        setStatus('Done.');
        resolve();
      });
      gif.render();
    });
  }

  async function handleFile(file) {
    revokeTrackedUrls();
    outputEl.hidden = true;
    previewsEl.hidden = true;
    currentImages = null;
    currentFileBaseName = file.name.replace(/\.[^.]+$/, '') || 'wiggle';

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

      currentImages = [imgLeft, imgRight];
      previewLeft.src = imgLeft.src;
      previewRight.src = imgRight.src;
      previewsEl.hidden = false;

      await renderGif();
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Something went wrong reading that file.', true);
    } finally {
      fileInput.disabled = false;
    }
  }

  fpsLabel.textContent = fpsSlider.value;
  fpsSlider.addEventListener('input', () => {
    fpsLabel.textContent = fpsSlider.value;
  });
  fpsSlider.addEventListener('change', () => {
    if (currentImages) renderGif();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    dropZone.addEventListener(evt, () => {
      dropZone.classList.remove('dragover');
    })
  );
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
})();
