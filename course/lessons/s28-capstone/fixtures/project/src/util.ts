// FIXME: this only trims ASCII whitespace, not full-width spaces
export function normalizeTitle(title: string): string {
  return title.trim()
}

export function slugify(title: string): string {
  return normalizeTitle(title).toLowerCase().replaceAll(/\s+/g, '-')
}
