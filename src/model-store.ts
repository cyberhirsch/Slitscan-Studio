// Persistent model cache in the Origin Private File System (File System Access
// API). Models download once and live in the browser's private storage, keyed
// by filename under a "models" directory. No picker, survives reloads.

async function getModelsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("models", { create: true });
}

export async function modelExists(filename: string): Promise<boolean> {
  try {
    const dir = await getModelsDir();
    await dir.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

export async function modelSize(filename: string): Promise<number> {
  try {
    const dir = await getModelsDir();
    const fh = await dir.getFileHandle(filename);
    return (await fh.getFile()).size;
  } catch {
    return 0;
  }
}

export async function readModel(filename: string): Promise<ArrayBuffer> {
  const dir = await getModelsDir();
  const fh = await dir.getFileHandle(filename);
  return (await fh.getFile()).arrayBuffer();
}

export async function deleteModel(filename: string): Promise<void> {
  const dir = await getModelsDir();
  await dir.removeEntry(filename).catch(() => {});
}

/** Stream a URL to OPFS, reporting 0..1 progress (NaN if length unknown). */
export async function downloadModel(
  filename: string, url: string, onProgress: (p: number) => void,
): Promise<void> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length") || 0);

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress(total ? received / total : NaN);
    }
  }

  const dir = await getModelsDir();
  const fh = await dir.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  try {
    await writable.write(new Blob(chunks as BlobPart[]));
  } finally {
    await writable.close();
  }
  onProgress(1);
}
