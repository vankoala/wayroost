// Which new-chat view this device shows: the one box, or the sheet with every choice in it.
// It lives on the device, in storage a browser may refuse (private mode, blocked site data), so both
// directions are wrapped: a device that cannot remember uses the site default.

const KEY = 'wayroost.newChat.advanced';

/** True when this device last asked for the sheet with the choices in it. */
export function advancedWanted(chatFirst = false): boolean {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === '1' ? true : saved === '0' ? false : !chatFirst;
  } catch {
    return !chatFirst;
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
