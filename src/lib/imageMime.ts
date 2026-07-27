/** Image extensions the code browser previews inline (ext → mime). */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export const isImagePath = (p: string): boolean =>
  Boolean(IMAGE_MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()]);
