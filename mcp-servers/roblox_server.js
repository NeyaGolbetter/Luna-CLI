#!/usr/bin/env node
/**
 * Luna Roblox Executor MCP server (stdio transport).
 *
 * Connects Luna CLI to a local Luna Roblox bridge:
 *
 *   luna mcp add roblox-executor node ./mcp-servers/roblox_server.js
 *
 * The bridge (luna bridge start / luna tunnel start) forwards scripts to the
 * actual Roblox executor via WS sidecar, direct HTTP, or the Luau polling
 * script — see roblox_executor_client.{js,luau} in this folder.
 *
 * Config via env:
 *   LUNA_BRIDGE_URL   default http://127.0.0.1:8172
 *   LUNA_BRIDGE_KEY   optional shared bearer key (must match bridge --key later)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_URL = (process.env.LUNA_BRIDGE_URL || 'http://127.0.0.1:8172').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.LUNA_BRIDGE_TIMEOUT_MS || 60_000);

const GAME_STATE_LUAU = `
local ok, info = pcall(function()
  local plr = game.Players.LocalPlayer
  local char = plr and plr.Character
  local root = char and char:FindFirstChild("HumanoidRootPart")
  local cam = workspace.CurrentCamera
  local data = {
    placeId = game.PlaceId,
    serverPlayers = #game.Players:GetPlayers(),
    localPlayer = plr and plr.Name or nil,
    position = root and { x = math.floor(root.Position.X), y = math.floor(root.Position.Y), z = math.floor(root.Position.Z) } or nil,
    camera = cam and { x = math.floor(cam.CFrame.Position.X), y = math.floor(cam.CFrame.Position.Y), z = math.floor(cam.CFrame.Position.Z) } or nil,
  }
  return data
end)
if ok then
  return game:GetService("HttpService"):JSONEncode(info)
else
  return "ERROR: " .. tostring(info)
end
`;

async function bridgeFetch(path, init) {
  const res = await fetch(BRIDGE_URL + path, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`bridge ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function executeScript(script) {
  const res = await bridgeFetch('/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'bridge refused the script');
  return body.data;
}

const server = new McpServer({ name: 'roblox-executor', version: '0.1.0' });

server.tool(
  'run_luau_script',
  'Execute a Luau script on the connected Roblox client via the Luna Roblox bridge. Returns the script\'s return value as text.',
  { script: z.string().min(1).describe('The Luau source code to execute') },
  async ({ script }) => {
    try {
      const out = await executeScript(script);
      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `EXECUTOR ERROR: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_game_state',
  'Read the current Roblox game state (place id, local player, player count, character/camera positions) from the connected client.',
  {},
  async () => {
    try {
      const out = await executeScript(GAME_STATE_LUAU);
      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `EXECUTOR ERROR: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_bridge_status',
  'Check whether the Luna Roblox bridge has an executor attached and which backend is active.',
  {},
  async () => {
    try {
      const res = await bridgeFetch('/status', { method: 'GET' });
      return { content: [{ type: 'text', text: JSON.stringify(await res.json(), null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `BRIDGE UNREACHABLE: ${e.message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
