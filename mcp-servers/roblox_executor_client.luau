-- Luna Roblox polling client (Luau)
--
-- Paste this into your executor (or loadstring it) so the executor becomes
-- the "executor backend" of the Luna Roblox bridge. It polls the bridge for
-- jobs and posts the results back.
--
--   local BRIDGE = "http://127.0.0.1:8172"      -- same machine
--   -- or, over a Cloudflare Tunnel:
--   local BRIDGE = "https://abcd1234.trycloudflare.com"
--
-- Executor API shims are auto-detected (request / http_request,
-- JSONEncode/JSONDecode / json.encode/decode).

local _G = _G
local http = game:GetService("HttpService")

local requestFn = _G.request or _G.http_request or request
local encodeFn = _G.json and _G.json.encode or _G.JSONEncode or http.JSONEncode
local decodeFn = _G.json and _G.json.decode or _G.JSONDecode or http.JSONDecode
local loadFn = _G.loadstring or _G.load

local BRIDGE = "http://127.0.0.1:8172"
local POLL_INTERVAL = 0.5
local CLIENT_ID = "lua-" .. math.random(1, 999999)

if not requestFn or not loadFn then
  warn("[luna] missing executor API: request/loadstring — this executor may not work")
end

warn(("[luna] polling client active — bridge=%s client=%s"):format(BRIDGE, CLIENT_ID))

local function postResult(id, ok, data, err)
  if not requestFn then return end
  local body = encodeFn({ id = id, ok = ok, data = data, error = err })
  local ok2 = pcall(requestFn, BRIDGE .. "/execute/result", {
    method = "POST",
    headers = { ["Content-Type"] = "application/json" },
    data = body,
  })
  if not ok2 then
    warn("[luna] failed to post result: " .. tostring(data or err))
  end
end

while true do
  local ok, res = pcall(requestFn, BRIDGE .. "/execute/poll?id=" .. CLIENT_ID, { method = "GET" })
  if ok and res and res.success and res.body and res.body ~= "" then
    local jobOk, job = pcall(decodeFn, res.body)
    if jobOk and job and job.script then
      local runOk, out = pcall(function()
        return (loadFn(job.script))()
      end)
      local text
      if runOk then
        if out == nil then
          text = "(nil)"
        elseif typeof(out) == "table" then
          local encOk, enc = pcall(encodeFn, out)
          text = encOk and enc or tostring(out)
        else
          text = tostring(out)
        end
      end
      postResult(job.id, runOk, text, runOk and nil or tostring(out))
    end
  end
  task.wait(POLL_INTERVAL)
end
