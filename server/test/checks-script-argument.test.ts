import { expect, it } from 'vitest';
import { scriptArgument } from '../src/checks/common.js';

it('names the script an interpreter runs, never one a pager or editor reads', () => {
  expect(scriptArgument(['/usr/bin/python3', '-u', '/home/me/demo/helper-mcp.py', '--note=x'])).toBe('/home/me/demo/helper-mcp.py');
  expect(scriptArgument(['python3.12', '/home/me/demo/helper-mcp.py'])).toBe('/home/me/demo/helper-mcp.py');
  expect(scriptArgument(['/home/me/demo/helper-mcp.py'])).toBe('/home/me/demo/helper-mcp.py');
  expect(scriptArgument(['/usr/bin/less', '/demo/gateway-copy/helper-mcp.py'])).toBeUndefined();
  expect(scriptArgument(['vim', '/home/me/demo/helper-mcp.py'])).toBeUndefined();
  expect(scriptArgument(['python3', '-c', 'print(1)'])).toBeUndefined();
});
