extends Node

# JavaScript bridge for Playwright AI QA
# Exposes game state to window.gameState

var main_node: Node = null

func _ready() -> void:
	# Wait for main scene to be ready
	call_deferred("_find_main")
	# Expose time scale control to JavaScript
	if OS.has_feature("web"):
		JavaScriptBridge.eval("""
window.setTimeScale = function(scale) {
	window._godotTimeScale = scale;
};
window.getTimeScale = function() {
	return window._godotTimeScale || 1.0;
};
""")

func _find_main() -> void:
	main_node = get_tree().get_root().get_node_or_null("Main")

func _process(_delta: float) -> void:
	if not OS.has_feature("web"):
		return
	_sync_time_scale()
	_update_js_state()

func _sync_time_scale() -> void:
	var scale = JavaScriptBridge.eval("window._godotTimeScale || 1.0")
	if scale is float and scale > 0.0 and scale != Engine.time_scale:
		Engine.time_scale = scale

func _update_js_state() -> void:
	if main_node == null:
		main_node = get_tree().get_root().get_node_or_null("Main")
	if main_node == null:
		return

	var player = main_node.get_node_or_null("Player")
	var hud = main_node.get_node_or_null("HUD")
	var upgrade_ui = main_node.get_node_or_null("UpgradeUI")
	var upgrade_manager = main_node.get_node_or_null("UpgradeManager")

	var player_hp: float = 0.0
	var max_hp: float = 100.0
	var player_x: float = 0.0
	var player_y: float = 0.0

	if player != null and player.has_method("get_hp"):
		player_hp = player.current_hp
		max_hp = player.max_hp
		player_x = player.global_position.x
		player_y = player.global_position.y

	var score: int = 0
	var level: int = 1
	var kill_count: int = 0
	var elapsed_time: float = 0.0

	if main_node.get("score") != null:
		score = main_node.score
	if main_node.get("level") != null:
		level = main_node.level
	if main_node.get("kill_count") != null:
		kill_count = main_node.kill_count
	if main_node.get("elapsed_time") != null:
		elapsed_time = main_node.elapsed_time

	var enemy_count: int = 0
	var enemies_node = main_node.get_node_or_null("Enemies")
	if enemies_node != null:
		enemy_count = enemies_node.get_child_count()

	var is_game_over: bool = false
	if main_node.get("game_over") != null:
		is_game_over = main_node.game_over

	var is_upgrade_screen: bool = false
	if upgrade_ui != null:
		is_upgrade_screen = upgrade_ui.visible

	# Build upgrade options array
	var upgrade_options_js := "[]"
	if upgrade_ui != null and upgrade_ui.visible:
		var options = upgrade_ui.get_current_options() if upgrade_ui.has_method("get_current_options") else []
		var arr := []
		for opt in options:
			arr.append('{"name":"%s","description":"%s"}' % [opt.get("name", ""), opt.get("description", "")])
		upgrade_options_js = "[" + ",".join(arr) + "]"

	# Build current upgrades object
	var current_upgrades_js := "{}"
	if upgrade_manager != null and upgrade_manager.has_method("get_upgrades_dict"):
		var upgrades = upgrade_manager.get_upgrades_dict()
		var parts := []
		for key in upgrades:
			parts.append('"%s":%d' % [key, upgrades[key]])
		current_upgrades_js = "{" + ",".join(parts) + "}"

	var js_code := """
window.gameState = {
	playerHP: %f,
	maxHP: %f,
	playerX: %f,
	playerY: %f,
	score: %d,
	level: %d,
	killCount: %d,
	elapsedTime: %f,
	enemyCount: %d,
	isGameOver: %s,
	isUpgradeScreen: %s,
	upgradeOptions: %s,
	currentUpgrades: %s
};
""" % [
		player_hp,
		max_hp,
		player_x,
		player_y,
		score,
		level,
		kill_count,
		elapsed_time,
		enemy_count,
		"true" if is_game_over else "false",
		"true" if is_upgrade_screen else "false",
		upgrade_options_js,
		current_upgrades_js
	]

	JavaScriptBridge.eval(js_code)
