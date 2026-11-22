const blobs = new Map();
export const seedBlob = (id, owner, type = "image/jpeg") => blobs.set(id, { metadata: { owner, type }, data: new ArrayBuffer(300) });
export const getStore = () => ({
  set: async (k, v, o) => { blobs.set(k, { ...o, data: v }); },
  getMetadata: async (k) => (blobs.has(k) ? { metadata: blobs.get(k).metadata } : null),
  getWithMetadata: async (k) => (blobs.has(k) ? { data: blobs.get(k).data, metadata: blobs.get(k).metadata } : null),
});
