import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Luau payload executed on the connected Roblox client to read game state.
 * Returns a JSON string (the executor's `loadstring` return value is
 * stringified by the bridge side).
 */
export const GAME_STATE_LUAU = `
local ok, info = pcall(function()
  local plr = game.Players.LocalPlayer
  local char = plr and plr.Character
  local root = char and char:FindFirstChild("HumanoidRootPart")
  local cam = workspace.CurrentCamera
  local data = {
    placeId = game.PlaceId,
    universeId = nil,
    serverPlayers = #game.Players:GetPlayers(),
    localPlayer = plr and plr.Name or nil,
    character = char and char:IsDescendantOf(workspace) and true or false,
    position = root and { x = math.floor(root.Position.X), y = math.floor(root.Position.Y), z = math.floor(root.Position.Z) } or nil,
    camera = cam and { x = math.floor(cam.CFrame.Position.X), y = math.floor(cam.CFrame.Position.Y), z = math.floor(cam.CFrame.Position.Z) } or nil,
  }
  local okU, u = pcall(function() return game:GetService("MarketplaceService"):GetUniverseId?() end)
  if okU then data.universeId = u end
  return data
end)
if ok then
  local http = game:GetService("HttpService")
  return http:JSONEncode(info)
else
  return "ERROR: " .. tostring(info)
end
`;

/** What the bridge needs to forward a script to the actual executor. */
export interface RobloxExecutor {
  /** Execute a Luau script and return its stringified result (throws on failure). */
  execute(script: string): Promise<string>;
  /** Human-readable attachment status for /status and get_bridge_status. */
  describe(): { attached: boolean; backend: 'ws-companion' | 'http' | 'polling' | 'none'; detail: string };
}

/**
 * Register the canonical Roblox MCP tools (Module C.3):
 *  - run_luau_script(script: string)
 *  - get_game_state()
 *  - get_bridge_status()
 * Reused by both the bridge's SSE endpoint and the standalone stdio server.
 */
export function registerRobloxTools(server: McpServer, exec: RobloxExecutor): void {
  server.tool(
    'run_luau_script',
    'Execute a Luau script on the connected Roblox client via the Luna Roblox bridge (local or over a Cloudflare Tunnel). The script runs through the executor\'s loadstring; its return value is returned as text.',
    { script: z.string().min(1).describe('The Luau source code to execute') },
    async ({ script }) => {
      try {
        const out = await exec.execute(script);
        return { content: [{ type: 'text', text: out }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `EXECUTOR ERROR: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_game_state',
    'Read the current Roblox game state (place id, local player, player count, character + camera positions) from the connected client.',
    {},
    async () => {
      try {
        const out = await exec.execute(GAME_STATE_LUAU);
        return { content: [{ type: 'text', text: out }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `EXECUTOR ERROR: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_bridge_status',
    'Check whether the Luna Roblox bridge has an executor attached and which backend is in use (ws companion, direct HTTP, or polling script).',
    {},
    async () => {
      const s = exec.describe();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                attached: s.attached,
                backend: s.backend,
                detail: s.detail,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
