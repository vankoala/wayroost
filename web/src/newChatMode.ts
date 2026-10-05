// Which new-chat view this device shows: the one box, or the sheet with every choice in it.
// It lives on the device, in storage a browser may refuse (private mode, blocked site data), so both
// directions are wrapped: a device that cannot remember just gets the box every time.

const KEY = 'wayroost.newChat.advanced';

/** True when this device last asked for the sheet with the choices in it. */
export function advancedWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false; // storage refused or missing: open the box, and ask again next time
  }
}

/** Remember this device's choice. Refused storage is not an error the person can act on. */
export function rememberAdvanced(wanted: boolean): void {
  try {
    localStorage.setItem(KEY, wanted ? '1' : '0');
  } catch {
    // Stands for this sheet only.
  }
}
