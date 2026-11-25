import pkg from '../../package.json';

const PROJECT_URL = 'https://github.com/thinkaliker/MultiModalNav';

/** "MultiModalNav/<version> (+<project url>; <contact>)" with the contact sanitised for a header. */
export function userAgent(contact: string | undefined): string {
  const clean = (contact ?? '').replace(/[^\x20-\x7e]|[();]/g, '').trim().slice(0, 200);
  return `MultiModalNav/${pkg.version} (+${PROJECT_URL}${clean ? `; ${clean}` : ''})`;
}
