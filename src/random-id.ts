const base36digit = (n: number): string => {
  const s = n.toString(36)
  return s.substring(s.length - 1)
}

export const randomID = (length = 12): string => {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return [...array].map(base36digit).join('')
}
