export function normalizeName(text: unknown): string;
export function songArtists(
  song: unknown,
): { id: number; mid: string; name: string }[];
export function recordingKey(song: unknown): string;
export function mergeResults<T>(
  first: T[],
  second: T[],
  seen?: Set<string>,
): T[];
export function highlightRuns(
  text: string,
  query: string,
): { text: string; match: boolean }[];
export function namesArtist(
  query: string,
  artist: { name?: string; alias?: string } | undefined,
): boolean;
export const SORTS: string[];
export function arrange<T>(songs: T[], filter?: string, sort?: string): T[];
export function albumsOf<T extends { album: string; cover: string }>(
  songs: T[],
): { name: string; cover: string; songs: T[] }[];
export function releaseDate(ms: number): string;
