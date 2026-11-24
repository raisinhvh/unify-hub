local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local LogService = game:GetService("LogService")
-- Bump together with PROTOCOL_VERSION in roblox.ts whenever the command protocol changes.
local PROTOCOL_VERSION = 3
local DEFAULT_PORT = 34872
local PLUGIN_LOADED_AT = os.clock()

-- Studio loads plugins again inside every playtest DataModel. The edit copy pairs with Unify and owns the
-- widget. A playtest's server copy connects as a "test" session: it runs commands in the live game, ends
-- the test (StudioTestService:EndTest only works from the test's server) and relays commands to the
-- client copy, which cannot make HTTP requests.
local IS_EDIT = RunService:IsEdit()
local ROLE = if IS_EDIT then "edit" elseif RunService:IsServer() then "server" else "client"
local StudioTestService = game:GetService("StudioTestService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RELAY_NAME = "UnifyBridgeRelay"
-- Results travel from the client copy to the server copy in pieces this long.
local RELAY_CHUNK = 200000

local sessionId = HttpService:GenerateGUID(false)
local playtestState = nil
local playtestError = nil
-- Deadline (os.clock) of the command being run; Unify sends how long it will wait for the result.
local commandDeadline = math.huge

-- Plugin chunk environment (Instance, game, print, math, …); not the shared _G table.
local pluginEnvironment = getfenv()

-- Only the edit copy has a toolbar and widget; playtest copies read the saved pairing code.
local toggleButton, statusLabel, pairingBox, widget = nil, nil, nil, nil
if IS_EDIT then
	local toolbar = plugin:CreateToolbar("Unify")
	toggleButton = toolbar:CreateButton("UnifyBridge", "Toggle the Unify Bridge", "")
	toggleButton.ClickableWhenViewportHidden = true

	local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 280, 140, 220, 110)
	widget = plugin:CreateDockWidgetPluginGuiAsync("UnifyBridgeWidget", widgetInfo)
	widget.Title = "Unify Bridge"
	widget.Enabled = true

	local background = Instance.new("Frame")
	background.Name = "Background"
	background.Size = UDim2.fromScale(1, 1)
	background.BackgroundColor3 = Color3.fromRGB(19, 16, 14)
	background.BorderSizePixel = 0
	background.Parent = widget

	-- The Unify logo (media/unify.svg, a 32x32 viewBox) rebuilt from Frames: two wood-toned L blocks.
	local logo = Instance.new("Frame")
	logo.Name = "Logo"
	logo.Position = UDim2.fromOffset(10, 10)
	logo.Size = UDim2.fromOffset(20, 20)
	logo.BackgroundTransparency = 1
	logo.Parent = background

	local LOGO_LIGHT = Color3.fromRGB(201, 164, 101)
	local LOGO_DARK = Color3.fromRGB(139, 106, 53)
	local logoRects = {
		{ 4, 2, 12.4, 27.6, LOGO_LIGHT },
		{ 12.4, 19.2, 15.5, 27.6, LOGO_LIGHT },
		{ 19.6, 4.4, 28, 30, LOGO_DARK },
		{ 16.5, 21.6, 19.6, 30, LOGO_DARK },
	}
	for _, rect in logoRects do
		local block = Instance.new("Frame")
		block.Position = UDim2.fromScale(rect[1] / 32, rect[2] / 32)
		block.Size = UDim2.fromScale((rect[3] - rect[1]) / 32, (rect[4] - rect[2]) / 32)
		block.BackgroundColor3 = rect[5]
		block.BorderSizePixel = 0
		block.Parent = logo
	end

	statusLabel = Instance.new("TextLabel")
	statusLabel.Name = "Status"
	statusLabel.Position = UDim2.fromOffset(38, 10)
	statusLabel.Size = UDim2.new(1, -48, 1, -56)
	statusLabel.BackgroundTransparency = 1
	statusLabel.Font = Enum.Font.Gotham
	statusLabel.TextColor3 = Color3.fromRGB(239, 234, 228)
	statusLabel.TextSize = 16
	statusLabel.TextWrapped = true
	statusLabel.TextXAlignment = Enum.TextXAlignment.Left
	statusLabel.TextYAlignment = Enum.TextYAlignment.Top
	statusLabel.Parent = background

	pairingBox = Instance.new("TextBox")
	pairingBox.Name = "PairingCode"
	pairingBox.Position = UDim2.new(0, 10, 1, -38)
	pairingBox.Size = UDim2.new(1, -20, 0, 28)
	pairingBox.BackgroundColor3 = Color3.fromRGB(27, 23, 20)
	pairingBox.BorderSizePixel = 0
	pairingBox.ClearTextOnFocus = false
	pairingBox.Font = Enum.Font.GothamMedium
	pairingBox.PlaceholderText = "Pairing code"
	pairingBox.PlaceholderColor3 = Color3.fromRGB(108, 98, 90)
	pairingBox.TextColor3 = Color3.fromRGB(239, 234, 228)
	pairingBox.TextSize = 14
	pairingBox.TextXAlignment = Enum.TextXAlignment.Left
	pairingBox.Parent = background

	local pairingCorner = Instance.new("UICorner")
	pairingCorner.CornerRadius = UDim.new(0, 6)
	pairingCorner.Parent = pairingBox

	local pairingStroke = Instance.new("UIStroke")
	pairingStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	pairingStroke.Color = Color3.fromRGB(46, 39, 34)
	pairingStroke.Parent = pairingBox

	local pairingPadding = Instance.new("UIPadding")
	pairingPadding.PaddingLeft = UDim.new(0, 8)
	pairingPadding.PaddingRight = UDim.new(0, 8)
	pairingPadding.Parent = pairingBox
end

local function trim(value)
	return (value:gsub("^%s*(.-)%s*$", "%1"))
end

local savedCode = plugin:GetSetting("UnifyPairingCode")
local pairingCode = type(savedCode) == "string" and string.upper(trim(savedCode)) or ""
if pairingBox then
	pairingBox.Text = pairingCode
end

-- Unify shows "CODE" on the default port and "CODE:PORT" when UNIFY_ROBLOX_PORT moves it.
local function parsePairing(text)
	local code, port = string.match(text, "^([^:]*):(%d+)$")
	if code then
		return code, tonumber(port)
	end
	return text, DEFAULT_PORT
end

local function baseUrl()
	local _, port = parsePairing(pairingCode)
	return "http://127.0.0.1:" .. tostring(port)
end

local function setStatus(value)
	if statusLabel then
		statusLabel.Text = value
	end
end

-- "/" separates names when the path has an unescaped "/", otherwise "."; "\" escapes the next character.
-- roblox.ts LUAU_RESOLVE follows the same rules.
local function splitPath(path)
	local separator = string.find(string.gsub(path, "\\.", ""), "/", 1, true) and "/" or "."
	local segments, current, index = {}, {}, 1
	while index <= #path do
		local char = string.sub(path, index, index)
		if char == "\\" and index < #path then
			index += 1
			table.insert(current, string.sub(path, index, index))
		elseif char == separator then
			if #current > 0 then
				table.insert(segments, table.concat(current))
			end
			table.clear(current)
		else
			table.insert(current, char)
		end
		index += 1
	end
	if #current > 0 then
		table.insert(segments, table.concat(current))
	end
	if segments[1] == "game" then
		table.remove(segments, 1)
	end
	return segments
end

local function resolvePath(path)
	path = type(path) == "string" and path or ""
	local segments = splitPath(path)
	if #segments == 0 then
		return game
	end

	local current = game:FindFirstChild(segments[1])
	if not current then
		local ok, service = pcall(game.GetService, game, segments[1])
		if ok then
			current = service
		end
	end
	if not current then
		error(string.format('No instance at path "%s": "%s" was not found under "game"', path, segments[1]), 0)
	end

	local traversed = { segments[1] }
	for index = 2, #segments do
		local name = segments[index]
		local child = current:FindFirstChild(name)
		if not child then
			local parentPath = table.concat(traversed, "/")
			error(string.format('No instance at path "%s": "%s" was not found under "%s"', path, name, parentPath), 0)
		end
		current = child
		table.insert(traversed, name)
	end
	return current
end

local function instancePath(instance)
	if instance == game then
		return "game"
	end
	local segments = {}
	local current = instance
	while current and current ~= game do
		table.insert(segments, 1, (string.gsub(current.Name, "[\\/]", "\\%0")))
		current = current.Parent
	end
	return table.concat(segments, "/")
end

local function clampNumber(value, defaultValue, minimum, maximum)
	local number = tonumber(value) or defaultValue
	return math.clamp(math.floor(number), minimum, maximum)
end

local function sortedChildren(instance)
	local children = instance:GetChildren()
	if instance == workspace then
		-- The plugin's own capture rig is not part of the place.
		for index = #children, 1, -1 do
			if children[index].Name == "UnifyBridgeCaptureRig" and not children[index].Archivable then
				table.remove(children, index)
			end
		end
	end
	table.sort(children, function(left, right)
		if left.Name == right.Name then
			return left.ClassName < right.ClassName
		end
		return left.Name < right.Name
	end)
	return children
end

local function matchesClass(instance, className)
	if not className or className == "" then
		return true
	end
	local ok, matches = pcall(function()
		return instance:IsA(className)
	end)
	return ok and matches
end

local function treeOperation(args)
	local root = resolvePath(args.path)
	local depthLimit = clampNumber(args.depth, 3, 0, 20)
	local maxNodes = clampNumber(args.maxNodes, 300, 1, 2000)
	local className = type(args.className) == "string" and args.className or nil
	local rootInfo = { path = instancePath(root), className = root.ClassName, childCount = #root:GetChildren() }
	local nodes = {}
	local stack = {}
	local visited = 0
	local truncated = false

	local function pushChildren(instance, depth)
		local children = sortedChildren(instance)
		for index = #children, 1, -1 do
			table.insert(stack, { instance = children[index], depth = depth })
		end
	end

	if depthLimit > 0 then
		pushChildren(root, 1)
	end
	-- Pre-order so the listing reads as an indented hierarchy; the root is reported separately.
	while #stack > 0 do
		local entry = table.remove(stack)
		visited = visited + 1
		if matchesClass(entry.instance, className) then
			if #nodes >= maxNodes then
				truncated = true
				break
			end
			table.insert(nodes, {
				path = instancePath(entry.instance),
				name = entry.instance.Name,
				className = entry.instance.ClassName,
				depth = entry.depth,
				childCount = #entry.instance:GetChildren(),
			})
		end
		if entry.depth < depthLimit then
			pushChildren(entry.instance, entry.depth + 1)
		end
		if visited % 500 == 0 then
			task.wait()
		end
	end

	return { root = rootInfo, nodes = nodes, truncated = truncated, total = visited }
end

local function findOperation(args)
	local start = resolvePath(args.path)
	local nameNeedle = type(args.name) == "string" and string.lower(args.name) or nil
	local className = type(args.className) == "string" and args.className or nil
	if (not nameNeedle or nameNeedle == "") and (not className or className == "") then
		error("find requires name or className", 0)
	end
	local limit = clampNumber(args.limit, 50, 1, 500)
	local matches = {}
	local stack = {}
	for _, child in ipairs(sortedChildren(start)) do
		table.insert(stack, child)
	end
	local visited = 0
	local truncated = false
	while #stack > 0 do
		local instance = table.remove(stack)
		visited = visited + 1
		local nameMatches = not nameNeedle
			or nameNeedle == ""
			or string.find(string.lower(instance.Name), nameNeedle, 1, true) ~= nil
		if nameMatches and matchesClass(instance, className) then
			table.insert(matches, { path = instancePath(instance), className = instance.ClassName })
			if #matches >= limit then
				truncated = #stack > 0 or #instance:GetChildren() > 0
				break
			end
		end
		local children = sortedChildren(instance)
		for index = #children, 1, -1 do
			table.insert(stack, children[index])
		end
		if visited % 500 == 0 then
			task.wait()
		end
	end
	return { matches = matches, truncated = truncated }
end

local DEFAULT_PROPERTIES = {
	"Name",
	"ClassName",
	"Parent",
	"Archivable",
	"Position",
	"Size",
	"CFrame",
	"Orientation",
	"Anchored",
	"CanCollide",
	"CanTouch",
	"CanQuery",
	"Massless",
	"Transparency",
	"Color",
	"BrickColor",
	"Material",
	"Shape",
	"Text",
	"TextColor3",
	"Font",
	"TextSize",
	"Visible",
	"Enabled",
	"Active",
	"ZIndex",
	"LayoutOrder",
	"AnchorPoint",
	"BackgroundColor3",
	"BackgroundTransparency",
	"Image",
	"ImageColor3",
	"Value",
	"Disabled",
	"RunContext",
	"LinkedSource",
	"Brightness",
	"Range",
	"Volume",
	"SoundId",
	"Looped",
	"PlaybackSpeed",
	"MeshId",
	"TextureID",
	"Health",
	"MaxHealth",
	"WalkSpeed",
	"JumpPower",
	"JumpHeight",
	"DisplayName",
	"PrimaryPart",
	"Adornee",
}

local function valueToString(value)
	if typeof(value) == "Instance" then
		return instancePath(value)
	end
	return tostring(value)
end

local function propertiesOperation(args)
	if type(args.path) ~= "string" then
		error('properties requires "path"', 0)
	end
	local instance = resolvePath(args.path)
	local properties = {}
	local requested = args.properties
	local explicit = type(requested) == "table"
	if not explicit then
		requested = DEFAULT_PROPERTIES
	end
	for _, propertyName in ipairs(requested) do
		if type(propertyName) == "string" then
			local ok, value = pcall(function()
				return instance[propertyName]
			end)
			if ok then
				if value ~= nil then
					properties[propertyName] = valueToString(value)
				end
			elseif explicit then
				-- The default list covers many classes; only report misses the caller asked for.
				properties[propertyName] = "<unreadable>"
			end
		end
	end

	local attributes = {}
	local attributesOk, rawAttributes = pcall(function()
		return instance:GetAttributes()
	end)
	if attributesOk then
		for name, value in pairs(rawAttributes) do
			attributes[name] = valueToString(value)
		end
	end
	local tags = {}
	local tagsOk, rawTags = pcall(function()
		return CollectionService:GetTags(instance)
	end)
	if tagsOk then
		tags = rawTags
	end
	return {
		path = instancePath(instance),
		className = instance.ClassName,
		name = instance.Name,
		childCount = #instance:GetChildren(),
		properties = properties,
		attributes = attributes,
		tags = tags,
	}
end

local function sourceOperation(args)
	if type(args.path) ~= "string" then
		error('source requires "path"', 0)
	end
	local instance = resolvePath(args.path)
	if not instance:IsA("LuaSourceContainer") then
		error("Instance is not a LuaSourceContainer", 0)
	end
	-- Unify truncates tool output at 60k characters, so one piece stays well below that.
	local maxChars = clampNumber(args.maxChars, 20000, 100, 50000)
	local ok, source = pcall(function()
		return instance.Source
	end)
	if not ok then
		error("Source is not readable", 0)
	end
	local lines = #source > 0 and string.split(string.gsub(source, "\r\n", "\n"), "\n") or {}
	if #lines > 0 and lines[#lines] == "" then
		table.remove(lines)
	end
	local startLine = clampNumber(args.startLine, 1, 1, math.max(#lines, 1))
	local endLine = clampNumber(args.endLine, #lines, startLine, math.max(#lines, 1))
	local shown, size = {}, 0
	for index = startLine, math.min(endLine, #lines) do
		size += #lines[index] + 1
		-- Always return at least one line, even when it alone exceeds maxChars.
		if size > maxChars and #shown > 0 then
			break
		end
		table.insert(shown, string.sub(lines[index], 1, maxChars))
	end
	local result = {
		path = instancePath(instance),
		className = instance.ClassName,
		source = table.concat(shown, "\n"),
		startLine = startLine,
		lineCount = #lines,
	}
	if instance:IsA("Script") then
		local runOk, runContext = pcall(function()
			return instance.RunContext
		end)
		if runOk then
			result.runContext = tostring(runContext)
		end
	end
	return result
end

local EXECUTE_MAX_CODE_BYTES = 200000
local EXECUTE_MAX_LOG_LINES = 100
local EXECUTE_MAX_LINE_CHARS = 2000
local EXECUTE_MAX_RETURNS = 100
local EXECUTE_TIMEOUT_SECONDS = 20
local UTF8_REPLACEMENT = "\239\191\189"

local function boundExecuteText(text)
	local parts = {}
	local byteCount = 0
	local index = 1
	local length = #text
	local replacementLen = #UTF8_REPLACEMENT

	while index <= length do
		local codepointOk, codepoint = pcall(utf8.codepoint, text, index)
		if codepointOk and codepoint then
			local char = utf8.char(codepoint)
			local charLen = #char
			if byteCount + charLen > EXECUTE_MAX_LINE_CHARS then
				break
			end
			parts[#parts + 1] = char
			byteCount = byteCount + charLen
			index = index + charLen
		else
			if byteCount + replacementLen > EXECUTE_MAX_LINE_CHARS then
				break
			end
			parts[#parts + 1] = UTF8_REPLACEMENT
			byteCount = byteCount + replacementLen
			index = index + 1
		end
	end

	local sanitized = table.concat(parts)
	if index <= length then
		sanitized = sanitized .. "..."
	end
	return sanitized
end

local OUTPUT_LOG_MAX_ENTRIES = 2000
local outputLog = {}
-- Every entry gets the next sequence number; callers page with it instead of clearing the shared log.
local outputLogSequence = 0
local logLevelMap = {
	[Enum.MessageType.MessageOutput] = "output",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError] = "error",
}

local function appendOutputLog(message, messageType, timestamp)
	local level = logLevelMap[messageType] or "output"
	outputLogSequence += 1
	table.insert(outputLog, {
		sequence = outputLogSequence,
		timestamp = tonumber(timestamp) or os.time(),
		level = level,
		message = boundExecuteText(tostring(message or "")),
	})
	if #outputLog > OUTPUT_LOG_MAX_ENTRIES then
		table.remove(outputLog, 1)
	end
end

local historyOk, logHistory = pcall(function()
	return LogService:GetLogHistory()
end)
if historyOk and type(logHistory) == "table" then
	for _, entry in ipairs(logHistory) do
		if type(entry) == "table" then
			appendOutputLog(entry.message, entry.messageType, entry.timestamp)
		end
	end
end

local messageOutConnection = LogService.MessageOut:Connect(function(message, messageType)
	appendOutputLog(message, messageType, os.time())
end)

local function outputLogOperation(args)
	local limit = clampNumber(args.limit, 100, 1, 1000)
	local requestedLevel = type(args.level) == "string" and string.lower(args.level) or "all"
	if requestedLevel == "warn" then
		requestedLevel = "warning"
	end
	if
		requestedLevel ~= "all"
		and requestedLevel ~= "output"
		and requestedLevel ~= "info"
		and requestedLevel ~= "warning"
		and requestedLevel ~= "error"
	then
		error('level must be "all", "output", "info", "warning", or "error"', 0)
	end
	local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
	local since = tonumber(args.since) or 0
	local matches = {}
	for _, entry in ipairs(outputLog) do
		if
			entry.sequence > since
			and (requestedLevel == "all" or requestedLevel == entry.level)
			and (not contains or string.find(string.lower(entry.message), contains, 1, true))
		then
			table.insert(matches, entry)
		end
	end
	local entries = {}
	local first = math.max(1, #matches - limit + 1)
	for index = first, #matches do
		local entry = matches[index]
		table.insert(entries, { timestamp = entry.timestamp, level = entry.level, message = entry.message })
	end
	return { entries = entries, total = #matches, truncated = #matches > limit, cursor = outputLogSequence }
end

local function selectionList(selectionService)
	local result = {}
	for _, instance in ipairs(selectionService:Get()) do
		table.insert(result, { path = instancePath(instance), className = instance.ClassName })
	end
	return result
end

local function selectionOperation(args)
	local ok, selectionService = pcall(game.GetService, game, "Selection")
	if not ok then
		error("Cannot access Selection: " .. tostring(selectionService), 0)
	end
	local action = args.action or "get"
	if action ~= "get" and action ~= "set" then
		error('action must be "get" or "set"', 0)
	end
	if action == "get" then
		local getOk, selection = pcall(selectionList, selectionService)
		if not getOk then
			error("Cannot get selection: " .. tostring(selection), 0)
		end
		return { selection = selection }
	end
	if type(args.paths) ~= "table" then
		error('selection set requires "paths" to be an array of strings', 0)
	end
	local resolved = {}
	local missing = {}
	local pathCount = 0
	for key, path in pairs(args.paths) do
		if type(path) ~= "string" or type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
			error('selection set requires "paths" to be an array of strings', 0)
		end
		pathCount = pathCount + 1
	end
	if pathCount ~= #args.paths then
		error('selection set requires "paths" to be an array of strings', 0)
	end
	for _, path in ipairs(args.paths) do
		local resolveOk, instance = pcall(resolvePath, path)
		if resolveOk then
			table.insert(resolved, instance)
		else
			table.insert(missing, path)
		end
	end
	local setOk, setError = pcall(selectionService.Set, selectionService, resolved)
	if not setOk then
		error("Cannot set selection: " .. tostring(setError), 0)
	end
	local getOk, selection = pcall(selectionList, selectionService)
	if not getOk then
		error("Cannot get selection: " .. tostring(selection), 0)
	end
	return { selection = selection, missing = missing }
end

-- True when Studio is in plain edit mode, false while a test runs or tears down, nil when unknown.
local function editModeActive()
	local ok, active = pcall(function()
		return game:GetService("StudioTestService").EditModeActive
	end)
	if ok and type(active) == "boolean" then
		return active
	end
	return nil
end

-- Studio's own EditModeActive wins when it is available, so a test call that never returned cannot leave
-- playtestState stuck and block every later start.
local function playtestRunning()
	local active = editModeActive()
	local legacyOk, legacyRunning = pcall(RunService.IsRunning, RunService)
	if legacyOk and legacyRunning == true then
		return true
	end
	if active ~= nil then
		return not active
	end
	return playtestState ~= nil
end

-- Waits until check() is true or the command budget runs out; returns whether it became true.
local function waitFor(check, seconds)
	local deadline = math.min(os.clock() + seconds, commandDeadline - 0.5)
	while not check() do
		if os.clock() > deadline then
			return false
		end
		task.wait(0.1)
	end
	return true
end

local function playtestOperation(args)
	local action = args.action
	if action ~= "status" and action ~= "start" and action ~= "stop" then
		error('action must be "status", "start", or "stop"', 0)
	end
	local mode = args.mode or "run"
	if mode ~= "run" and mode ~= "play" then
		error('mode must be "run" or "play"', 0)
	end
	if action == "status" then
		local running = playtestRunning()
		local message = playtestError and ("Last playtest failed: " .. playtestError)
			or (running and "Playtest is running" or "Studio is in edit mode")
		playtestError = nil
		return { running = running, state = running and (playtestState or "running") or "edit", message = message }
	end
	local testService = game:GetService("StudioTestService")
	if action == "start" then
		if playtestRunning() then
			error("A playtest is already running or still shutting down. Stop it first, or wait a few seconds.", 0)
		end
		-- Studio ends a test started while it is still opening the place, and refuses a new one while the
		-- last is tearing down, so wait for the plugin to settle and edit mode to hold for a second.
		waitFor(function()
			return os.clock() - PLUGIN_LOADED_AT > 3
		end, 3)
		local settledSince = os.clock()
		local settled = waitFor(function()
			if playtestRunning() then
				settledSince = os.clock()
			end
			return os.clock() - settledSince >= 1
		end, 10)
		if not settled then
			error("Studio has not returned to edit mode since the last playtest. Wait a few seconds, or press Stop in Studio.", 0)
		end
		plugin:SetSetting("UnifyPendingTest", { session = sessionId, at = os.time(), mode = mode })
		playtestState = mode
		playtestError = nil
		local finished, failure = false, nil
		task.spawn(function()
			local ok, err = pcall(function()
				-- Both calls yield until the test ends.
				if mode == "play" then
					testService:ExecutePlayModeAsync({ unifySession = sessionId })
				else
					testService:ExecuteRunModeAsync({ unifySession = sessionId })
				end
			end)
			if not ok then
				failure = tostring(err)
				playtestError = failure
			end
			finished = true
			playtestState = nil
		end)
		-- Confirm Studio actually left edit mode before reporting success.
		local left = waitFor(function()
			return finished or editModeActive() == false
		end, 15)
		if failure then
			playtestError = nil
			error("Studio refused to start the playtest: " .. failure, 0)
		elseif finished then
			error("The playtest ended immediately (Studio may still be loading the place). Retry in a few seconds.", 0)
		elseif not left and editModeActive() ~= nil then
			error("Studio has not started the playtest yet. Check playtest status in a few seconds before retrying.", 0)
		end
		return { running = true, state = mode, message = "Playtest started (" .. mode .. " mode)" }
	end
	if not playtestRunning() then
		return { running = false, state = "edit", message = "No playtest was running" }
	end
	-- Unify normally asks the test's own server session to end it first (args.serverEnded). Otherwise try
	-- EndTest from here, which some Studio versions honor, and RunService:Stop for the old in-place Run mode.
	if not args.serverEnded or not waitFor(function()
		return not playtestRunning()
	end, 5) then
		pcall(testService.EndTest, testService, "unify")
		local legacyOk, legacyRunning = pcall(RunService.IsRunning, RunService)
		if legacyOk and legacyRunning then
			pcall(RunService.Stop, RunService)
		end
	end
	if not waitFor(function()
		return not playtestRunning()
	end, 15) then
		error("Studio is still running the playtest. Press Stop in Studio (Shift+F5), then check playtest status.", 0)
	end
	return { running = false, state = "edit", message = "Playtest stopped" }
end

local function executeInstancePathString(instance)
	local pathOk, path = pcall(instancePath, instance)
	if not pathOk then
		return "<instance path unavailable>"
	end
	return boundExecuteText(path)
end

local function executeOutputString(value)
	if value == nil then
		return "nil"
	end
	if typeof(value) == "Instance" then
		return executeInstancePathString(value)
	end
	local ok, text = pcall(tostring, value)
	if not ok then
		return "<unstringifiable>"
	end
	return boundExecuteText(text)
end

local function appendExecuteLog(logs, line, logState)
	if logState.truncated then
		return
	end
	if #logs >= EXECUTE_MAX_LOG_LINES then
		logState.truncated = true
		table.insert(logs, "(log output truncated)")
		return
	end
	table.insert(logs, boundExecuteText(line))
end

local function formatExecuteLogArgs(...)
	local count = select("#", ...)
	local parts = {}
	for index = 1, count do
		parts[index] = executeOutputString(select(index, ...))
	end
	return table.concat(parts, "\t")
end

-- Studio caches each ModuleScript's first require for the whole session, so edits to a module never
-- reach plugin code. This require compiles the module's current Source instead, once per execute call.
local function buildFreshRequire(env)
	local loadedModules = {}
	local loadingModules = {}

	local function freshRequire(target)
		if typeof(target) ~= "Instance" or not target:IsA("ModuleScript") then
			return require(target)
		end
		if loadedModules[target] ~= nil then
			return loadedModules[target].value
		end
		local modulePath = target:GetFullName()
		if loadingModules[target] then
			error("require cycle: " .. modulePath .. " requires itself through its dependencies", 2)
		end

		local chunk, compileErr = loadstring(target.Source, "=" .. modulePath)
		if not chunk then
			error("Compile error in " .. modulePath .. ": " .. executeOutputString(compileErr), 2)
		end
		local moduleEnvironment = setmetatable({ script = target }, { __index = env })
		setfenv(chunk, moduleEnvironment)

		loadingModules[target] = true
		local packed = table.pack(pcall(chunk))
		loadingModules[target] = nil
		if not packed[1] then
			error(packed[2], 0)
		end
		if packed.n ~= 2 then
			error(modulePath .. ": Module code did not return exactly one value", 2)
		end
		loadedModules[target] = { value = packed[2] }
		return packed[2]
	end

	return freshRequire
end

local function buildExecuteEnvironment(logs, logState, fresh)
	local env = setmetatable({}, { __index = pluginEnvironment })
	env._G = env
	function env.print(...)
		appendExecuteLog(logs, formatExecuteLogArgs(...), logState)
	end
	function env.warn(...)
		appendExecuteLog(logs, formatExecuteLogArgs(...), logState)
	end
	if fresh then
		env.require = buildFreshRequire(env)
	end
	return env
end

local function formatExecuteError(message, logs)
	if #logs == 0 then
		return message
	end
	return message .. "\n\nOutput:\n" .. table.concat(logs, "\n")
end

-- The wrapper sits on the code's first line, so error line numbers match the code. Values cross the
-- BindableEvent as Instances (shown as paths) or strings, because functions and mixed tables cannot.
local GAME_EXECUTE_PREFIX = 'local __unifyOut = script:WaitForChild("UnifyBridgeOut") '
	.. 'local function __unifyText(value) local ok, text = pcall(tostring, value) return if ok then text else "<unstringifiable>" end '
	.. "local function __unifySend(kind, ...) local count = select(\"#\", ...) local values = {} "
	.. "for index = 1, count do local value = select(index, ...) "
	.. 'values[index] = if typeof(value) == "Instance" then { instance = value } else { text = __unifyText(value) } end '
	.. "__unifyOut:Fire(kind, count, values) end "
	.. 'local function print(...) __unifySend("log", ...) end local function warn(...) __unifySend("log", ...) end '
	.. '__unifySend("done", pcall(function(...) '
local GAME_EXECUTE_SUFFIX = "\nend))"

-- In a playtest the code runs as a game Script (server) or client Script, so it shares the game's require
-- cache and state. Plugin code would get fresh, uninitialized copies of every module.
local function executeInGame(code)
	local source = GAME_EXECUTE_PREFIX .. code .. GAME_EXECUTE_SUFFIX
	local loadstringOk, chunk, compileErr = pcall(loadstring, source, "UnifyBridgeExecute")
	if loadstringOk and not chunk then
		error("Compile error: " .. executeOutputString(compileErr), 0)
	end

	local logs = {}
	local logState = { truncated = false }
	local finished, succeeded, values = false, false, {}
	local runner = Instance.new("Script")
	runner.Name = "UnifyBridgeExecute"
	runner.Archivable = false
	if ROLE == "client" then
		runner.RunContext = Enum.RunContext.Client
	end
	local out = Instance.new("BindableEvent")
	out.Name = "UnifyBridgeOut"
	out.Parent = runner
	out.Event:Connect(function(kind, count, items)
		local parts = {}
		for index = 1, count do
			local item = items[index]
			parts[index] = if item and item.instance then executeInstancePathString(item.instance)
				else boundExecuteText(item and item.text or "nil")
		end
		if kind == "log" then
			appendExecuteLog(logs, table.concat(parts, "\t"), logState)
		elseif kind == "done" and not finished then
			succeeded = parts[1] == "true"
			values = { table.unpack(parts, 2, count) }
			values.n = count - 1
			finished = true
		end
	end)
	runner.Source = source
	-- A client Script runs from ReplicatedStorage; anything made here stays on this client.
	runner.Parent = if ROLE == "server" then game:GetService("ServerScriptService") else ReplicatedStorage

	local timeoutSeconds = math.max(1, math.min(EXECUTE_TIMEOUT_SECONDS, commandDeadline - os.clock() - 1))
	local deadline = os.clock() + timeoutSeconds
	while not finished and os.clock() < deadline do
		task.wait()
	end
	runner:Destroy()
	if not finished then
		error(
			formatExecuteError(
				"Execution timed out after "
					.. tostring(math.floor(timeoutSeconds))
					.. " seconds and was stopped at its last yield; changes made before that were kept. Non-yielding loops cannot be interrupted and can freeze Studio.",
				logs
			),
			0
		)
	end
	if not succeeded then
		error(formatExecuteError(values[1] or "nil", logs), 0)
	end
	local returns = {}
	local returnsTruncated = values.n > EXECUTE_MAX_RETURNS
	for index = 1, math.min(values.n, EXECUTE_MAX_RETURNS) do
		returns[index] = values[index]
	end
	if returnsTruncated then
		table.insert(returns, "(return values truncated)")
	end
	return { logs = logs, returns = returns, context = ROLE }
end

local function executeOperation(args)
	if type(args.code) ~= "string" then
		error('execute requires "code"', 0)
	end
	local code = args.code
	if trim(code) == "" then
		error("code must be a nonblank string", 0)
	end
	if #code > EXECUTE_MAX_CODE_BYTES then
		error("code must be at most 200000 bytes", 0)
	end
	if not IS_EDIT then
		return executeInGame(code)
	end

	local loadstringOk, chunk, compileErr = pcall(loadstring, code, "UnifyBridgeExecute")
	if not loadstringOk then
		error("loadstring is unavailable in this Studio context: " .. executeOutputString(chunk), 0)
	end
	if not chunk then
		error("Compile error: " .. executeOutputString(compileErr), 0)
	end

	local recording = nil
	if not RunService:IsRunning() then
		recording = ChangeHistoryService:TryBeginRecording("UnifyBridge.Execute", "Unify Execute")
		if not recording then
			error("Cannot execute: Studio is not accepting undo recordings.", 0)
		end
	end

	local function finishRecording(operation)
		if recording then
			ChangeHistoryService:FinishRecording(recording, operation)
		end
	end

	local logs = {}
	local logState = { truncated = false }
	local fresh = args.fresh == true
	local envOk, envErr = pcall(setfenv, chunk, buildExecuteEnvironment(logs, logState, fresh))
	if not envOk then
		finishRecording(Enum.FinishRecordingOperation.Cancel)
		error("Cannot prepare execution environment: " .. executeOutputString(envErr), 0)
	end

	local packed = nil
	local executionSucceeded = false
	local runtimeError = nil
	local finished = false
	-- Leave a second to post the result before Unify stops waiting.
	local timeoutSeconds = math.max(1, math.min(EXECUTE_TIMEOUT_SECONDS, commandDeadline - os.clock() - 1))
	local deadline = os.clock() + timeoutSeconds
	local thread = task.spawn(function()
		local ok, err = pcall(function()
			packed = table.pack(chunk())
		end)
		executionSucceeded = ok
		if not ok then
			runtimeError = err
		end
		finished = true
	end)

	while not finished and os.clock() < deadline do
		task.wait()
	end

	if not finished then
		task.cancel(thread)
		finishRecording(Enum.FinishRecordingOperation.Commit)
		error(
			formatExecuteError(
				"Execution timed out after "
					.. tostring(math.floor(timeoutSeconds))
					.. " seconds and was stopped at its last yield; changes made before that were kept. Non-yielding loops cannot be interrupted and can freeze Studio.",
				logs
			),
			0
		)
	end

	if not executionSucceeded then
		finishRecording(Enum.FinishRecordingOperation.Commit)
		error(formatExecuteError(executeOutputString(runtimeError), logs), 0)
	end

	finishRecording(Enum.FinishRecordingOperation.Commit)

	local returns = {}
	local count = packed.n
	local returnsTruncated = count > EXECUTE_MAX_RETURNS
	for index = 1, math.min(count, EXECUTE_MAX_RETURNS) do
		returns[index] = executeOutputString(packed[index])
	end
	if returnsTruncated then
		table.insert(returns, "(return values truncated)")
	end
	return { logs = logs, returns = returns, fresh = fresh }
end

local function countPlain(text, needle)
	local count, from = 0, 1
	while true do
		local first, last = string.find(text, needle, from, true)
		if not first then
			return count
		end
		count += 1
		from = last + 1
	end
end

local function setSourceOperation(args)
	if type(args.path) ~= "string" then
		error('set_source requires "path"', 0)
	end
	local instance = resolvePath(args.path)
	if not instance:IsA("LuaSourceContainer") then
		error("Instance is not a LuaSourceContainer", 0)
	end
	if type(args.source) ~= "string" and type(args.edits) ~= "table" then
		error("set_source requires source or edits", 0)
	end
	local scriptEditor = game:GetService("ScriptEditorService")
	local failure, applied, updated = nil, 0, nil
	-- The callback gets the live text (including unsaved editor changes) and must not yield.
	local function transform(old)
		if type(args.source) == "string" then
			updated = args.source
			return updated
		end
		local text = old
		for index, edit in ipairs(args.edits) do
			if type(edit) ~= "table" or type(edit.find) ~= "string" or edit.find == "" or type(edit.replace) ~= "string" then
				failure = "edits[" .. (index - 1) .. "] needs find and replace strings"
				return nil
			end
			local count = countPlain(text, edit.find)
			if count ~= 1 then
				failure = "edits["
					.. (index - 1)
					.. "].find matched "
					.. count
					.. " times; it must match exactly once. Read the script with roblox_source and include more surrounding text."
				return nil
			end
			local first, last = string.find(text, edit.find, 1, true)
			text = string.sub(text, 1, first - 1) .. edit.replace .. string.sub(text, last + 1)
			applied += 1
		end
		updated = text
		return text
	end
	local recording = ChangeHistoryService:TryBeginRecording("UnifyBridge.SetSource", "Unify Edit Script")
	local ok, err = pcall(scriptEditor.UpdateSourceAsync, scriptEditor, instance, transform)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			(ok and not failure) and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	if failure then
		error(failure .. " (nothing was changed)", 0)
	end
	if not ok then
		error("Could not update the script: " .. tostring(err), 0)
	end
	local _, newlines = string.gsub(updated or "", "\n", "")
	return {
		path = instancePath(instance),
		lineCount = updated == "" and 0 or newlines + 1,
		applied = type(args.edits) == "table" and applied or nil,
	}
end

-- Large values built by execute snippets (shared.__unifyBlob[key]) are read back in big pieces.
local function blobOperation(args)
	local blobs = shared.__unifyBlob or {}
	if type(args.key) ~= "string" then
		error('blob requires "key"', 0)
	end
	if args.delete == true then
		blobs[args.key] = nil
		return {}
	end
	local value = blobs[args.key]
	if type(value) ~= "string" then
		error("No blob named " .. args.key, 0)
	end
	local offset = clampNumber(args.offset, 1, 1, #value + 1)
	local length = clampNumber(args.length, 1048576, 1, 4194304)
	return { data = string.sub(value, offset, offset + length - 1), total = #value }
end

-- BEGIN Unify CAPTURE VIEW
-- Source of truth: capture-view.lua. Run `node sync-plugin.mjs` to embed it in UnifyBridge.server.lua (no runtime require).
local captureCache = {}
local captureOrder = {}
local CAPTURE_TTL = 300
local CAPTURE_LIMIT = 16
local StudioCaptureService = game:GetService("StudioCaptureService")
local CaptureService = game:GetService("CaptureService")
local captureBufferStatus = Enum.StudioCaptureBufferStatus
local preferredCaptureBackend = nil
local viewportCaptureActive = false
local studioCaptureInFlight = false
local studioCaptureWaiters = {}

-- Made on first use: in a playtest's server, a folder in workspace would replicate to the client.
local captureRig, agentCaptureCamera = nil, nil

local function ensureCaptureRig()
	if captureRig and captureRig.Parent then
		return
	end
	captureRig = Instance.new("Folder")
	captureRig.Name = "UnifyBridgeCaptureRig"
	captureRig.Archivable = false
	captureRig.Parent = workspace

	agentCaptureCamera = Instance.new("Camera")
	agentCaptureCamera.Name = "UnifyBridgeCaptureCamera"
	agentCaptureCamera.CameraType = Enum.CameraType.Scriptable
	agentCaptureCamera.Parent = captureRig
end

-- The user's real editor camera. Remembered whenever it is current, so a capture never has to trust
-- workspace.CurrentCamera, which may still be the agent camera after an earlier failure.
local editorCamera = nil

local function isAgentCamera(camera)
	return camera ~= nil and captureRig ~= nil and (camera == agentCaptureCamera or camera:IsDescendantOf(captureRig))
end

-- Returns the editor camera, switching the viewport back to it when it was left on the agent camera.
local function currentEditorCamera()
	local current = workspace.CurrentCamera
	if current and not isAgentCamera(current) then
		editorCamera = current
		return editorCamera
	end
	if not (editorCamera and editorCamera.Parent) then
		editorCamera = nil
		for _, child in ipairs(workspace:GetChildren()) do
			if child:IsA("Camera") and not isAgentCamera(child) then
				editorCamera = child
				break
			end
		end
	end
	if editorCamera and not viewportCaptureActive then
		workspace.CurrentCamera = editorCamera
	end
	return editorCamera
end

local cameraWatch = workspace:GetPropertyChangedSignal("CurrentCamera"):Connect(function()
	if not viewportCaptureActive then
		currentEditorCamera()
	end
end)
currentEditorCamera()

local function xyz(value)
	return { value.X, value.Y, value.Z }
end

local BASE64_ALPHABET = buffer.fromstring("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
-- Yield every 384 KB of input (a multiple of 3) so a large screenshot does not stall Studio.
local BASE64_YIELD_BYTES = 393216

local function base64Buffer(value, deadline)
	local length = buffer.len(value)
	if length > 6 * 1024 * 1024 then
		error("Screenshot is too large; reduce width and height.", 0)
	end
	local out = buffer.create(math.ceil(length / 3) * 4)
	local o = 0
	for offset = 0, length - 1, 3 do
		local a = buffer.readu8(value, offset)
		local b = if offset + 1 < length then buffer.readu8(value, offset + 1) else 0
		local c = if offset + 2 < length then buffer.readu8(value, offset + 2) else 0
		local word = a * 65536 + b * 256 + c
		buffer.writeu8(out, o, buffer.readu8(BASE64_ALPHABET, bit32.rshift(word, 18)))
		buffer.writeu8(out, o + 1, buffer.readu8(BASE64_ALPHABET, bit32.band(bit32.rshift(word, 12), 63)))
		buffer.writeu8(
			out,
			o + 2,
			if offset + 1 < length then buffer.readu8(BASE64_ALPHABET, bit32.band(bit32.rshift(word, 6), 63)) else 61
		)
		buffer.writeu8(out, o + 3, if offset + 2 < length then buffer.readu8(BASE64_ALPHABET, bit32.band(word, 63)) else 61)
		o += 4
		if offset > 0 and offset % BASE64_YIELD_BYTES == 0 then
			if os.clock() > deadline then
				error("Screenshot encoding timed out.", 0)
			end
			task.wait()
		end
	end
	return buffer.tostring(out)
end

local function pruneCaptures()
	for index = #captureOrder, 1, -1 do
		local id = captureOrder[index]
		if not captureCache[id] or os.clock() - captureCache[id].created > CAPTURE_TTL then
			captureCache[id] = nil
			table.remove(captureOrder, index)
		end
	end
end

local function pixelRay(view, x, y)
	local tanHalf = math.tan(math.rad(view.fieldOfView) / 2)
	local aspect = view.viewportSize.X / view.viewportSize.Y
	local direction =
		Vector3.new((2 * x / view.width - 1) * aspect * tanHalf, (1 - 2 * y / view.height) * tanHalf, -1).Unit
	return view.cframe.Position, view.cframe:VectorToWorldSpace(direction).Unit
end

local function visiblePart(part)
	return part:IsA("BasePart") and 1 - (1 - part.Transparency) * (1 - part.LocalTransparencyModifier) < 0.999
end

local function raycastVisible(origin, direction)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	local excluded = {}
	for index = 1, 64 do
		params.FilterDescendantsInstances = excluded
		local hit = workspace:Raycast(origin, direction, params)
		if not hit then
			return nil
		end
		if not hit.Instance:IsA("BasePart") or visiblePart(hit.Instance) then
			return hit
		end
		table.insert(excluded, hit.Instance)
		if index % 16 == 0 then
			task.wait()
		end
	end
	return nil
end

local function pickCapture(args)
	pruneCaptures()
	local cached = captureCache[args.captureId]
	if not cached then
		error("Capture expired or belongs to another Studio session. Capture again.", 0)
	end
	local index = args.viewIndex or 1
	local view = cached.views[index]
	if not view then
		error("viewIndex is not present in this capture.", 0)
	end
	local results = {}
	for _, point in ipairs(args.pixels) do
		if point.x < 0 or point.y < 0 or point.x >= view.width or point.y >= view.height then
			error("Pixel is outside the returned image dimensions.", 0)
		end
		local origin, direction = pixelRay(view, point.x, point.y)
		local hit = raycastVisible(origin, direction * (args.maxDistance or 10000))
		local result = { pixel = point, origin = xyz(origin), direction = xyz(direction), hit = hit ~= nil }
		if hit then
			result.path = instancePath(hit.Instance)
			result.className = hit.Instance.ClassName
			result.position = xyz(hit.Position)
			result.normal = xyz(hit.Normal)
			result.distance = hit.Distance
			result.material = hit.Material.Name
			for _, label in ipairs(view.labelInstances) do
				if hit.Instance == label.instance or hit.Instance:IsDescendantOf(label.instance) then
					result.label = label.id
					break
				end
			end
		end
		table.insert(results, result)
	end
	return {
		captureId = args.captureId,
		viewIndex = index,
		scene = "current",
		camera = "saved capture",
		results = results,
	}
end

local function captureTargets(args)
	local roots = {}
	local seen = {}
	local function add(instance)
		if not seen[instance] then
			seen[instance] = true
			table.insert(roots, instance)
		end
	end
	for _, path in ipairs(args.target or {}) do
		if path == "$selection" then
			for _, instance in ipairs(game:GetService("Selection"):Get()) do
				add(instance)
			end
		else
			add(resolvePath(path))
		end
	end
	-- No implicit selection fallback: the selection may belong to the user or another agent.
	-- Callers pass "$selection" explicitly when they mean it.
	return roots
end

local function geometry(roots)
	local parts = {}
	local seen = {}
	local candidates = {}
	local candidateSeen = {}
	local function addPart(part)
		if not seen[part] and part:IsA("BasePart") and part:IsDescendantOf(workspace) then
			seen[part] = true
			table.insert(parts, part)
			if #parts > 20000 then
				error("Target contains too many parts. Capture a smaller section.", 0)
			end
		end
	end
	local visited = 0
	local function addCandidates(root)
		visited = visited + 1
		if visited % 500 == 0 then
			task.wait()
		end
		if root:IsA("Model") or root:IsA("BasePart") then
			if not candidateSeen[root] then
				candidateSeen[root] = true
				table.insert(candidates, root)
			end
		else
			for _, child in ipairs(sortedChildren(root)) do
				addCandidates(child)
			end
		end
	end
	for _, root in ipairs(roots) do
		addPart(root)
		for i, instance in ipairs(root:GetDescendants()) do
			addPart(instance)
			if i % 500 == 0 then
				task.wait()
			end
		end
		addCandidates(root)
	end
	local corners = {}
	local minimum = Vector3.new(math.huge, math.huge, math.huge)
	local maximum = -minimum
	for i, part in ipairs(parts) do
		for _, x in ipairs({ -1, 1 }) do
			for _, y in ipairs({ -1, 1 }) do
				for _, z in ipairs({ -1, 1 }) do
					local point = part.CFrame:PointToWorldSpace(part.Size * Vector3.new(x, y, z) / 2)
					minimum = minimum:Min(point)
					maximum = maximum:Max(point)
					table.insert(corners, point)
				end
			end
		end
		if i % 500 == 0 then
			task.wait()
		end
	end
	return corners, minimum, maximum, candidates
end

local function framedCamera(name, center, corners, fov, aspect, padding)
	local offsets = {
		top = Vector3.new(0, 1, 0),
		bottom = Vector3.new(0, -1, 0),
		side = Vector3.new(1, 0, 0),
		front = Vector3.new(0, 0, -1),
		back = Vector3.new(0, 0, 1),
		perspective = Vector3.new(1, 0.8, 1).Unit,
	}
	local offset = offsets[name]
	if not offset then
		error("Unknown capture angle: " .. tostring(name), 0)
	end
	local up = (name == "top" or name == "bottom") and Vector3.new(0, 0, -1) or Vector3.yAxis
	local orientation = CFrame.lookAt(center + offset, center, up)
	local tanVertical = math.tan(math.rad(fov) / 2)
	local distance = 1
	for _, corner in ipairs(corners) do
		local p = orientation:VectorToObjectSpace(corner - center)
		distance = math.max(
			distance,
			p.Z + (math.abs(p.X) + padding) / (tanVertical * aspect),
			p.Z + (math.abs(p.Y) + padding) / tanVertical,
			p.Z + 1
		)
	end
	return CFrame.lookAt(center + offset * distance, center, up)
end

local function projectedLabels(camera, candidates, size, outputSize)
	local labels, instances = {}, {}
	for candidateIndex, instance in ipairs(candidates) do
		if #labels >= 200 then
			break
		end
		local anchors = {}
		if visiblePart(instance) then
			table.insert(anchors, instance)
		elseif instance:IsA("Model") then
			for _, part in ipairs(instance:GetDescendants()) do
				if visiblePart(part) then
					table.insert(anchors, part)
				end
			end
		end
		table.sort(anchors, function(a, b)
			return a.Size.X * a.Size.Y * a.Size.Z > b.Size.X * b.Size.Y * b.Size.Z
		end)
		local position, screen
		for _, anchor in ipairs(anchors) do
			-- A buried rock's center can be hidden while its top surface is visible.
			for _, offset in ipairs({
				Vector3.zero,
				Vector3.yAxis,
				-Vector3.yAxis,
				Vector3.xAxis,
				-Vector3.xAxis,
				Vector3.zAxis,
				-Vector3.zAxis,
			}) do
				local point = anchor.CFrame:PointToWorldSpace(anchor.Size * offset * 0.49)
				local _, onScreen = camera:WorldToViewportPoint(point)
				local delta = point - camera.CFrame.Position
				if onScreen and delta.Magnitude > 0.001 then
					local hit =
						raycastVisible(camera.CFrame.Position, delta.Unit * (delta.Magnitude + anchor.Size.Magnitude))
					if hit and (hit.Instance == instance or hit.Instance:IsDescendantOf(instance)) then
						position = hit.Position
						screen = camera:WorldToViewportPoint(position)
						break
					end
				end
			end
			if position then
				break
			end
		end
		if position then
			local id = #labels + 1
			table.insert(
				labels,
				{
					id = id,
					path = instancePath(instance),
					className = instance.ClassName,
					pixel = { x = screen.X * outputSize.X / size.X, y = screen.Y * outputSize.Y / size.Y },
					position = xyz(position),
				}
			)
			table.insert(instances, { id = id, instance = instance })
		end
		if candidateIndex % 20 == 0 then
			task.wait()
		end
	end
	return labels, instances
end

local function resolveCaptureBackend()
	if preferredCaptureBackend then
		return preferredCaptureBackend
	end
	local permOk, granted = pcall(StudioCaptureService.RequestScreenshotPermissionAsync, StudioCaptureService)
	if permOk and granted == true then
		preferredCaptureBackend = "StudioCaptureService"
	else
		preferredCaptureBackend = "CaptureService"
	end
	return preferredCaptureBackend
end

local function formatCaptureErrors(capture)
	local ok, errors = pcall(capture.GetErrors, capture)
	if not ok or type(errors) ~= "table" or #errors == 0 then
		return "unknown error"
	end
	local messages = {}
	for _, entry in ipairs(errors) do
		if type(entry) == "string" then
			table.insert(messages, entry)
		elseif type(entry) == "table" and type(entry.message) == "string" then
			table.insert(messages, entry.message)
		end
	end
	return #messages > 0 and table.concat(messages, "; ") or "unknown error"
end

local function waitForCaptureBuffer(capture, deadline)
	while capture.BufferStatus == captureBufferStatus.NotStarted
		or capture.BufferStatus == captureBufferStatus.Pending do
		if os.clock() > deadline then
			error("StudioCaptureService screenshot timed out. Focus this place's viewport and retry.", 0)
		end
		task.wait()
	end
	if capture.BufferStatus == captureBufferStatus.Error then
		error("StudioCaptureService failed: " .. formatCaptureErrors(capture), 0)
	end
end

local function withStudioCapture(work, deadline)
	if studioCaptureInFlight then
		local thread = coroutine.running()
		table.insert(studioCaptureWaiters, thread)
		while studioCaptureInFlight do
			if os.clock() > deadline then
				error("StudioCaptureService screenshot timed out waiting for another capture.", 0)
			end
			task.wait()
		end
	end
	studioCaptureInFlight = true
	local ok, result = pcall(work)
	studioCaptureInFlight = false
	local nextWaiter = table.remove(studioCaptureWaiters, 1)
	if nextWaiter then
		task.spawn(nextWaiter)
	end
	if not ok then
		error(tostring(result), 0)
	end
	return result
end

local function captureViewportRgbaStudio(outputSize, viewportSize, deadline)
	return withStudioCapture(function()
		if not StudioCaptureService:CanCaptureScreenshot() then
			error("Studio cannot capture a screenshot right now. Focus this place's viewport and retry.", 0)
		end
		local captureSize = Vector2.new(math.max(1, math.floor(viewportSize.X)), math.max(1, math.floor(viewportSize.Y)))
		local capture = StudioCaptureService:CaptureScreenshot({
			Position = Vector2.zero,
			CaptureSize = captureSize,
			OutputSize = outputSize,
			ResampleMode = Enum.ResamplerMode.Default,
			Format = Enum.StudioCaptureScreenshotFormat.RGBA8,
			UICaptureMode = Enum.UICaptureMode.None,
		})
		if capture == nil then
			error("StudioCaptureService returned no capture object.", 0)
		end
		waitForCaptureBuffer(capture, deadline)
		local pixelBuffer = capture:GetBuffer()
		local expectedBytes = outputSize.X * outputSize.Y * 4
		if buffer.len(pixelBuffer) ~= expectedBytes then
			error(
				"StudioCaptureService returned "
					.. tostring(buffer.len(pixelBuffer))
					.. " bytes; expected "
					.. tostring(expectedBytes)
					.. ".",
				0
			)
		end
		return base64Buffer(pixelBuffer, deadline)
	end, deadline)
end

local function captureViewportRgbaLegacy(outputSize, viewportSize, deadline)
	local contentId, failure, accepting = nil, nil, true
	local captureThread = task.spawn(function()
		local ok, err = pcall(function()
			CaptureService:CaptureScreenshot(function(id)
				if accepting then
					contentId = id
				end
			end)
		end)
		if not ok then
			failure = tostring(err)
		end
	end)
	local readyDeadline = math.min(deadline, os.clock() + 10)
	while not contentId and not failure and os.clock() < readyDeadline do
		task.wait()
	end
	accepting = false
	if failure then
		error("CaptureService failed: " .. failure, 0)
	end
	if not contentId then
		pcall(task.cancel, captureThread)
		error("CaptureService screenshot timed out. Activate the paired Studio viewport and retry.", 0)
	end
	local assetService = game:GetService("AssetService")
	local source, resized, abandoned, loaded = nil, nil, false, false
	local loadThread = task.spawn(function()
		local ok, image = pcall(assetService.CreateEditableImageAsync, assetService, Content.fromUri(contentId))
		if ok and image then
			if abandoned then
				image:Destroy()
			else
				source = image
			end
		else
			failure = ok and "EditableImage allocation failed." or tostring(image)
		end
		loaded = true
	end)
	while not loaded and os.clock() < readyDeadline do
		task.wait()
	end
	if not loaded then
		abandoned = true
		pcall(task.cancel, loadThread)
		error("Screenshot image loading timed out.", 0)
	end
	if not source then
		error("Cannot read CaptureService screenshot pixels: " .. tostring(failure), 0)
	end
	local ok, result = pcall(function()
		local aspectError = math.abs(source.Size.X / source.Size.Y - viewportSize.X / viewportSize.Y)
		if aspectError > 2 / source.Size.Y + 2 / viewportSize.Y then
			error("CaptureService returned a different viewport aspect ratio. Activate the paired place and retry.", 0)
		end
		resized = assetService:CreateEditableImage({ Size = outputSize })
		if not resized then
			error("Cannot allocate resized screenshot.", 0)
		end
		resized:DrawImageTransformed(
			Vector2.zero,
			Vector2.new(outputSize.X / source.Size.X, outputSize.Y / source.Size.Y),
			0,
			source,
			{
				PivotPoint = Vector2.zero,
				CombineType = Enum.ImageCombineType.Overwrite,
				SamplingMode = Enum.ResamplerMode.Default,
			}
		)
		return base64Buffer(resized:ReadPixelsBuffer(Vector2.zero, outputSize), deadline)
	end)
	if resized then
		resized:Destroy()
	end
	source:Destroy()
	if not ok then
		error(tostring(result), 0)
	end
	return result
end

local function captureViewportRgba(outputSize, viewportSize, deadline)
	if resolveCaptureBackend() == "StudioCaptureService" then
		return captureViewportRgbaStudio(outputSize, viewportSize, deadline)
	end
	return captureViewportRgbaLegacy(outputSize, viewportSize, deadline)
end

-- RenderStepped only fires in the DataModel Studio is drawing: not the edit place while a playtest shows,
-- nor a Play-mode server. Waiting on it without a deadline used to hang the whole bridge until the test ended.
local function waitForRenderedFrames(count, deadline)
	local frames = 0
	local connected, connection = pcall(function()
		return RunService.RenderStepped:Connect(function()
			frames += 1
		end)
	end)
	if not connected then
		error("This Studio session does not render a viewport, so it cannot be captured.", 0)
	end
	while frames < count and os.clock() < deadline do
		task.wait()
	end
	connection:Disconnect()
	if frames < count then
		error(
			"Studio is not drawing this viewport (a playtest is showing, or Studio is minimized). Capture after the test stops, or capture a Run-mode test with context \"server\".",
			0
		)
	end
end

-- Runs work with the viewport showing the agent camera, one capture at a time. The editor camera and its
-- CFrame, Focus and FieldOfView are always restored afterwards, even when work fails.
local function withAgentCamera(work, deadline)
	while viewportCaptureActive do
		if os.clock() > deadline then
			error("Timed out waiting for another capture to release the viewport.", 0)
		end
		task.wait()
	end
	local userCamera = currentEditorCamera()
	if not userCamera then
		error("No editor camera to return to after the capture; click into the viewport and retry.", 0)
	end
	local saved = { cframe = userCamera.CFrame, focus = userCamera.Focus, fieldOfView = userCamera.FieldOfView }
	ensureCaptureRig()
	viewportCaptureActive = true
	local ok, result = pcall(function()
		workspace.CurrentCamera = agentCaptureCamera
		return work()
	end)
	local restored, restoreError = pcall(function()
		workspace.CurrentCamera = userCamera
		if userCamera.CFrame ~= saved.cframe then
			userCamera.CFrame = saved.cframe
		end
		if userCamera.Focus ~= saved.focus then
			userCamera.Focus = saved.focus
		end
		if userCamera.FieldOfView ~= saved.fieldOfView then
			userCamera.FieldOfView = saved.fieldOfView
		end
	end)
	viewportCaptureActive = false
	if not restored then
		warn("Unify Bridge could not restore the editor camera: " .. tostring(restoreError))
	end
	if not ok then
		error(tostring(result), 0)
	end
	return result
end

local function cleanupCapture()
	cameraWatch:Disconnect()
	if isAgentCamera(workspace.CurrentCamera) and editorCamera and editorCamera.Parent then
		workspace.CurrentCamera = editorCamera
	end
	if captureRig then
		captureRig:Destroy()
	end
end

local function configureAgentCaptureCamera(renderCamera, args, name, center, corners, editorFov, aspect)
	renderCamera.FieldOfViewMode = Enum.FieldOfViewMode.Vertical
	renderCamera.FieldOfView = args.camera and args.camera.fieldOfView or editorFov
	if args.camera then
		renderCamera.CFrame = CFrame.lookAt(
			Vector3.new(unpack(args.camera.position)),
			Vector3.new(unpack(args.camera.lookAt)),
			Vector3.new(unpack(args.camera.up))
		)
	else
		renderCamera.CFrame = framedCamera(name, center, corners, renderCamera.FieldOfView, aspect, args.padding or 10)
	end
	renderCamera.Focus = CFrame.new(center)
end

local function captureViewOperation(args)
	if args.captureId then
		return pickCapture(args)
	end
	if ROLE == "client" then
		error("capture_view cannot read a Play client's viewport: Roblox does not expose its screenshot pixels. Capture in Run mode or edit mode instead.", 0)
	end
	-- A test in its own DataModel hides the edit viewport (a legacy in-place Run still draws it).
	if IS_EDIT and editModeActive() == false and not RunService:IsRunning() then
		error("The edit viewport is hidden while a playtest runs. Stop the test first, or capture a Run-mode test with context \"server\".", 0)
	end
	local userCamera = currentEditorCamera()
	if not userCamera or userCamera.ViewportSize.X < 1 or userCamera.ViewportSize.Y < 1 then
		error("No active Studio viewport camera.", 0)
	end
	local deadline = math.min(os.clock() + 45, commandDeadline - 1)
	local editorFov = userCamera.FieldOfView
	local roots = captureTargets(args)
	local views = args.views or { args.camera and "custom" or (#roots > 0 and "perspective" or "current") }
	local corners, minimum, maximum, candidates = geometry(roots)
	local needsBounds = false
	for _, name in ipairs(views) do
		if name ~= "current" and name ~= "custom" then
			needsBounds = true
		end
	end
	if needsBounds and #corners == 0 then
		error("Automatic framing requires target parts in Workspace or a nonempty Studio selection.", 0)
	end
	local center = #corners > 0 and (minimum + maximum) / 2 or userCamera.Focus.Position
	local snapshots, output = {}, {}
	local function captureFromCamera(index, name, renderCamera)
		local size = userCamera.ViewportSize
		local ratio = math.min((args.width or 768) / size.X, (args.height or 768) / size.Y, 1)
		local outputSize =
			Vector2.new(math.max(1, math.floor(size.X * ratio)), math.max(1, math.floor(size.Y * ratio)))
		local cf = renderCamera.CFrame
		local fov = renderCamera.FieldOfView
		local labels, labelInstances = {}, {}
		if args.labels then
			labels, labelInstances = projectedLabels(renderCamera, candidates, size, outputSize)
		end
		local pixels = captureViewportRgba(outputSize, size, deadline)
		if renderCamera.CFrame ~= cf or renderCamera.FieldOfView ~= fov or renderCamera.ViewportSize ~= size then
			error("Viewport changed during capture. Retry without moving the camera or resizing Studio.", 0)
		end
		table.insert(output, {
			viewIndex = index,
			view = name,
			width = outputSize.X,
			height = outputSize.Y,
			camera = {
				position = xyz(cf.Position),
				lookDirection = xyz(cf.LookVector),
				up = xyz(cf.UpVector),
				fieldOfView = fov,
			},
			labels = labels,
			labelsTruncated = args.labels and #labels >= 200 or false,
			pixelsBase64 = pixels,
		})
		snapshots[index] = {
			cframe = cf,
			fieldOfView = fov,
			viewportSize = size,
			width = outputSize.X,
			height = outputSize.Y,
			labelInstances = labelInstances,
		}
	end
	-- "current" views go first, through the user's own camera, before the viewport is switched away.
	local agentViews = {}
	for index, name in ipairs(views) do
		if args.camera == nil and name == "current" then
			captureFromCamera(index, name, userCamera)
		else
			table.insert(agentViews, index)
		end
	end
	if #agentViews > 0 then
		withAgentCamera(function()
			for _, index in ipairs(agentViews) do
				local size = userCamera.ViewportSize
				configureAgentCaptureCamera(agentCaptureCamera, args, views[index], center, corners, editorFov, size.X / size.Y)
				waitForRenderedFrames(2, deadline)
				captureFromCamera(index, views[index], agentCaptureCamera)
			end
		end, deadline)
	end
	table.sort(output, function(left, right)
		return left.viewIndex < right.viewIndex
	end)
	pruneCaptures()
	local id = HttpService:GenerateGUID(false)
	captureCache[id] = { created = os.clock(), views = snapshots }
	table.insert(captureOrder, id)
	while #captureOrder > CAPTURE_LIMIT do
		captureCache[table.remove(captureOrder, 1)] = nil
	end
	local targets = {}
	for _, root in ipairs(roots) do
		table.insert(targets, instancePath(root))
	end
	return {
		captureId = id,
		session = sessionId,
		place = game.Name,
		placeId = tostring(game.PlaceId),
		mode = RunService:IsRunning() and "running" or "edit",
		targets = targets,
		views = output,
	}
end
-- END Unify CAPTURE VIEW

-- These act on Studio's editor, so playtest copies refuse them.
local EDIT_ONLY = { selection = true, playtest = true, set_source = true }

local function executeCommand(command)
	local args = type(command.args) == "table" and command.args or {}
	local budget = tonumber(command.budgetMs)
	commandDeadline = budget and os.clock() + budget / 1000 or math.huge
	if not IS_EDIT and EDIT_ONLY[command.op] then
		error(tostring(command.op) .. " only works on the edit place.", 0)
	end
	if command.op == "capture_view" then
		return captureViewOperation(args)
	elseif command.op == "tree" then
		return treeOperation(args)
	elseif command.op == "find" then
		return findOperation(args)
	elseif command.op == "properties" then
		return propertiesOperation(args)
	elseif command.op == "source" then
		return sourceOperation(args)
	elseif command.op == "execute" then
		return executeOperation(args)
	elseif command.op == "output_log" then
		return outputLogOperation(args)
	elseif command.op == "selection" then
		return selectionOperation(args)
	elseif command.op == "playtest" then
		return playtestOperation(args)
	elseif command.op == "set_source" then
		return setSourceOperation(args)
	elseif command.op == "blob" then
		return blobOperation(args)
	end
	error("Unknown op: " .. tostring(command.op), 0)
end

local function postResult(code, body)
	return HttpService:RequestAsync({
		Url = baseUrl() .. "/result",
		Method = "POST",
		Headers = {
			["x-unify-token"] = code,
			["Content-Type"] = "application/json",
		},
		Body = HttpService:JSONEncode(body),
	})
end

local running = true
plugin.Unloading:Connect(function()
	running = false
	messageOutConnection:Disconnect()
	pcall(cleanupCapture)
end)

-- Runs a command without letting it hold the poll loop past its budget (plus a little grace). One that
-- overruns is left to finish on its own, since cancelling could leave the editor camera swapped, and
-- Unify (which has already timed out the call) gets an error so later commands keep flowing.
local function runCommand(command)
	local finished, ok, result = false, false, nil
	task.spawn(function()
		ok, result = pcall(executeCommand, command)
		finished = true
	end)
	local budget = tonumber(command.budgetMs)
	local deadline = if budget then os.clock() + budget / 1000 + 2 else math.huge
	while not finished and running and os.clock() < deadline do
		task.wait()
	end
	if not finished then
		return false, tostring(command.op) .. " overran its time limit and was left running; Studio moved on to the next command."
	end
	return ok, result
end

-- Playtest client copy: Studio refuses HTTP here, so commands come from the server copy over a
-- RemoteEvent and results go back the same way, in pieces.
if ROLE == "client" then
	task.spawn(function()
		local relay = ReplicatedStorage:WaitForChild(RELAY_NAME, 60)
		if not (relay and running) then
			return
		end
		relay.OnClientEvent:Connect(function(kind, payload)
			if kind ~= "command" or type(payload) ~= "string" then
				return
			end
			local decodeOk, command = pcall(HttpService.JSONDecode, HttpService, payload)
			if not (decodeOk and type(command) == "table") then
				return
			end
			local commandOk, result = pcall(executeCommand, command)
			local body = if commandOk
				then { id = command.id, ok = true, data = result }
				else { id = command.id, ok = false, error = tostring(result) }
			local encodeOk, text = pcall(HttpService.JSONEncode, HttpService, body)
			if not encodeOk then
				text = HttpService:JSONEncode({ id = command.id, ok = false, error = "Cannot encode the result: " .. tostring(text) })
			end
			local count = math.max(1, math.ceil(#text / RELAY_CHUNK))
			for index = 1, count do
				relay:FireServer("result", command.id, index, count, string.sub(text, (index - 1) * RELAY_CHUNK + 1, index * RELAY_CHUNK))
			end
		end)
		relay:FireServer("hello")
	end)
	return
end

-- Playtest server copy: a "test" session that runs commands in the live game, relays target "client"
-- commands, and ends the test.
if ROLE == "server" then
	local code, port = parsePairing(pairingCode)
	if code == "" then
		return
	end
	-- The edit session that started this test: from the test args, or the note it left (GetTestArgs is
	-- unreliable in some Studio versions).
	local parent = ""
	local argsOk, testArgs = pcall(StudioTestService.GetTestArgs, StudioTestService)
	if argsOk and type(testArgs) == "table" and type(testArgs.unifySession) == "string" then
		parent = testArgs.unifySession
	else
		local pending = plugin:GetSetting("UnifyPendingTest")
		if type(pending) == "table" and type(pending.session) == "string" and os.time() - (tonumber(pending.at) or 0) < 120 then
			parent = pending.session
		end
	end
	local base = "http://127.0.0.1:" .. tostring(port)
	local headers = { ["x-unify-token"] = code }
	local Players = game:GetService("Players")

	local relay = Instance.new("RemoteEvent")
	relay.Name = RELAY_NAME
	relay.Archivable = false
	relay.Parent = ReplicatedStorage
	plugin.Unloading:Connect(function()
		relay:Destroy()
	end)
	local relayClient = nil
	local relayWaiting = {}

	local function testQuery()
		return "session="
			.. HttpService:UrlEncode(sessionId)
			.. "&role=test&parent="
			.. HttpService:UrlEncode(parent)
			.. "&client="
			.. (if relayClient and relayClient.Parent then "1" else "0")
			.. "&placeId="
			.. HttpService:UrlEncode(tostring(game.PlaceId))
			.. "&place="
			.. HttpService:UrlEncode(game.Name)
			.. "&protocol="
			.. tostring(PROTOCOL_VERSION)
	end
	-- The long poll only reports the client when it starts; a ping tells Unify right away.
	local function announce()
		task.spawn(pcall, HttpService.RequestAsync, HttpService, { Url = base .. "/ping?" .. testQuery(), Method = "GET", Headers = headers })
	end

	relay.OnServerEvent:Connect(function(player, kind, id, index, count, chunk)
		if kind == "hello" then
			relayClient = player
			announce()
		elseif kind == "result" then
			local entry = relayWaiting[id]
			if entry and type(index) == "number" and type(count) == "number" and type(chunk) == "string" and entry.chunks[index] == nil then
				entry.chunks[index] = chunk
				entry.received += 1
				entry.count = count
			end
		end
	end)
	Players.PlayerRemoving:Connect(function(player)
		if player == relayClient then
			relayClient = nil
			announce()
		end
	end)

	local function relayToClient(command)
		if not (relayClient and relayClient.Parent) then
			return { id = command.id, ok = false, error = "The playtest client has not connected to Unify yet. Retry in a few seconds." }
		end
		local budget = (tonumber(command.budgetMs) or 30000) / 1000
		-- The client gets a second less, so its own timeout error arrives before Unify stops waiting.
		command.budgetMs = math.max(1000, (budget - 1) * 1000)
		local entry = { chunks = {}, received = 0, count = math.huge }
		relayWaiting[command.id] = entry
		relay:FireClient(relayClient, "command", HttpService:JSONEncode(command))
		local deadline = os.clock() + budget - 0.5
		while entry.received < entry.count and os.clock() < deadline and running do
			task.wait()
		end
		relayWaiting[command.id] = nil
		if entry.received < entry.count then
			return { id = command.id, ok = false, error = "The playtest client did not finish " .. tostring(command.op) .. " in time." }
		end
		local decodeOk, body = pcall(HttpService.JSONDecode, HttpService, table.concat(entry.chunks))
		if not (decodeOk and type(body) == "table") then
			return { id = command.id, ok = false, error = "The playtest client sent an unreadable result." }
		end
		body.id = command.id
		return body
	end

	task.spawn(function()
		while running do
			local ok, response = pcall(HttpService.RequestAsync, HttpService, {
				Url = base .. "/poll?" .. testQuery(),
				Method = "GET",
				Headers = headers,
			})
			if not running then
				break
			end
			if ok and response.StatusCode == 200 then
				local decodeOk, command = pcall(HttpService.JSONDecode, HttpService, response.Body)
				if decodeOk and type(command) == "table" then
					local body
					if command.op == "end_test" then
						body = { id = command.id, ok = true, data = { message = "Ending the playtest" } }
					elseif command.target == "client" then
						body = relayToClient(command)
					else
						local commandOk, result = runCommand(command)
						body = if commandOk
							then { id = command.id, ok = true, data = result }
							else { id = command.id, ok = false, error = tostring(result) }
					end
					pcall(HttpService.RequestAsync, HttpService, {
						Url = base .. "/result",
						Method = "POST",
						Headers = { ["x-unify-token"] = code, ["Content-Type"] = "application/json" },
						Body = HttpService:JSONEncode(body),
					})
					if command.op == "end_test" then
						-- Answered first: EndTest tears this DataModel down. It rejects nil, so pass a value.
						local ended, endError = pcall(StudioTestService.EndTest, StudioTestService, "unify")
						if ended then
							running = false
						else
							warn("Unify Bridge could not end the playtest: " .. tostring(endError))
						end
					end
				end
			elseif not (ok and response.StatusCode == 204) then
				task.wait(1)
			end
		end
	end)
	return
end

pairingBox.FocusLost:Connect(function()
	pairingCode = string.upper(trim(pairingBox.Text))
	pairingBox.Text = pairingCode
	plugin:SetSetting("UnifyPairingCode", pairingCode)
end)

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local function bridgeQuery()
	return "session="
		.. HttpService:UrlEncode(sessionId)
		.. "&placeId="
		.. HttpService:UrlEncode(tostring(game.PlaceId))
		.. "&place="
		.. HttpService:UrlEncode(game.Name)
		.. "&protocol="
		.. tostring(PROTOCOL_VERSION)
end

-- A quick request that confirms Unify and the pairing code before the long poll starts.
local function connect(code)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl() .. "/ping?" .. bridgeQuery(),
			Method = "GET",
			Headers = { ["x-unify-token"] = code },
		})
	end)
	-- 404: an older toolpack without /ping is still running, but it does answer /poll.
	if ok and (response.StatusCode == 200 or response.StatusCode == 404) then
		setStatus("Connected to Unify. Place: " .. game.Name)
		return true
	elseif ok and response.StatusCode == 401 then
		setStatus("Wrong pairing code.")
	elseif ok then
		setStatus("Unify answered with HTTP " .. response.StatusCode .. ". Re-upload the Roblox toolpack in Unify.")
	else
		setStatus(
			"Unify is not reachable ("
				.. tostring(response)
				.. "). Is the Roblox toolpack enabled in Unify, and are HTTP requests allowed?"
		)
	end
	return false
end

task.spawn(function()
	local lastReachable = false
	while running do
		local code = parsePairing(pairingCode)
		if code == "" then
			setStatus("Enter the pairing code shown in Unify (Custom Tool Calls tab).")
			task.wait(0.5)
		elseif not lastReachable then
			setStatus("Connecting to Unify...")
			lastReachable = connect(code)
			if not running then
				break
			end
			if not lastReachable then
				task.wait(3)
			end
		else
			local ok, response = pcall(function()
				return HttpService:RequestAsync({
					Url = baseUrl() .. "/poll?" .. bridgeQuery(),
					Method = "GET",
					Headers = { ["x-unify-token"] = code },
				})
			end)
			if not running then
				break
			end
			if not ok then
				lastReachable = false
				setStatus("Unify is not reachable. Open Unify and allow HTTP requests when Studio asks.")
				task.wait(3)
			elseif response.StatusCode == 401 then
				lastReachable = false
				setStatus("Wrong pairing code.")
				task.wait(3)
			elseif response.StatusCode == 204 then
				if not lastReachable then
					lastReachable = true
					setStatus("Connected to Unify. Place: " .. game.Name)
				end
				task.wait()
			elseif response.StatusCode == 200 then
				lastReachable = true
				setStatus("Connected to Unify. Place: " .. game.Name)
				local decodeOk, command = pcall(function()
					return HttpService:JSONDecode(response.Body)
				end)
				if decodeOk and type(command) == "table" then
					local commandOk, result = runCommand(command)
					local body
					if commandOk then
						body = { id = command.id, ok = true, data = result }
					else
						body = { id = command.id, ok = false, error = tostring(result) }
					end
					local postOk = pcall(postResult, code, body)
					if not postOk then
						lastReachable = false
						setStatus("Unify is not reachable. Open Unify and allow HTTP requests when Studio asks.")
						task.wait(3)
					else
						task.wait()
					end
				else
					lastReachable = false
					setStatus("Unify is not reachable. Open Unify and allow HTTP requests when Studio asks.")
					task.wait(3)
				end
			else
				lastReachable = false
				setStatus("Unify is not reachable. Open Unify and allow HTTP requests when Studio asks.")
				task.wait(3)
			end
		end
	end
end)
