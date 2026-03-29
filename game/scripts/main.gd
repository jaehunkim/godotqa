extends Node2D

var score: int = 0
var level: int = 1
var kill_count: int = 0
var elapsed_time: float = 0.0
var game_over: bool = false
var paused_for_upgrade: bool = false

@onready var player: CharacterBody2D = $Player
@onready var enemies_container: Node2D = $Enemies
@onready var bullets_container: Node2D = $Bullets
@onready var hud: CanvasLayer = $HUD
@onready var upgrade_ui: CanvasLayer = $UpgradeUI
@onready var game_over_ui: CanvasLayer = $GameOver
@onready var upgrade_manager: Node = $UpgradeManager
@onready var enemy_spawner: Node = $EnemySpawner
@onready var js_bridge: Node = $JSBridge

func _ready() -> void:
	# Connect player signals
	player.died.connect(_on_player_died)
	player.xp_changed.connect(_on_xp_changed)
	player.level_up.connect(_on_level_up)

	# Setup spawner
	enemy_spawner.setup(enemies_container)

	# Connect upgrade UI
	upgrade_ui.upgrade_chosen.connect(_on_upgrade_chosen)

	# Connect game over restart
	game_over_ui.restart_requested.connect(_restart_game)

	# Initial HUD update
	hud.update_hp(player.current_hp, player.max_hp)
	hud.update_xp(0, player.xp_to_next)
	hud.update_level(1)
	hud.update_kills(0)
	hud.update_time(0.0)

func _process(delta: float) -> void:
	if game_over:
		return
	if paused_for_upgrade:
		return

	elapsed_time += delta
	hud.update_time(elapsed_time)
	hud.update_hp(player.current_hp, player.max_hp)

	# Connect newly spawned enemies
	for enemy in enemies_container.get_children():
		if not enemy.died.is_connected(_on_enemy_died):
			enemy.died.connect(_on_enemy_died)

func _on_player_died() -> void:
	game_over = true
	enemy_spawner.set_process(false)
	get_tree().paused = false
	game_over_ui.show_game_over(kill_count, elapsed_time, level)

func _on_xp_changed(current_xp: int, xp_to_next: int) -> void:
	hud.update_xp(current_xp, xp_to_next)

func _on_level_up(new_level: int) -> void:
	level = new_level
	hud.update_level(new_level)
	_show_upgrade_selection()

func _on_enemy_died(pos: Vector2, xp_val: int) -> void:
	kill_count += 1
	score += xp_val * 10
	hud.update_kills(kill_count)

	# Spawn XP orb — orb grants XP on collection
	_spawn_xp_orb(pos, xp_val)

func _spawn_xp_orb(pos: Vector2, xp_val: int) -> void:
	var orb := XPOrb.new(xp_val)
	add_child(orb)
	orb.global_position = pos

func _show_upgrade_selection() -> void:
	paused_for_upgrade = true
	enemy_spawner.set_process(false)
	# Freeze all enemies
	for enemy in enemies_container.get_children():
		enemy.set_physics_process(false)

	var options = upgrade_manager.get_random_options(3)
	upgrade_ui.show_upgrades(options)

func _on_upgrade_chosen(upgrade_id: String) -> void:
	upgrade_manager.apply_upgrade(upgrade_id, player)
	paused_for_upgrade = false
	enemy_spawner.set_process(true)
	# Unfreeze enemies
	for enemy in enemies_container.get_children():
		enemy.set_physics_process(true)

func _restart_game() -> void:
	get_tree().reload_current_scene()


# XP Orb inline class
class XPOrb extends Node2D:
	var xp_value: int = 1
	var attracted: bool = false
	var attract_target: Vector2 = Vector2.ZERO
	var speed: float = 200.0
	var lifetime: float = 8.0
	var elapsed: float = 0.0

	func _init(xp: int) -> void:
		xp_value = xp

	func _ready() -> void:
		add_to_group("xp_orbs")

	func attract(target_pos: Vector2) -> void:
		attracted = true
		attract_target = target_pos

	func _process(delta: float) -> void:
		elapsed += delta
		if elapsed >= lifetime:
			queue_free()
			return

		if attracted:
			var dir := (attract_target - global_position)
			if dir.length() < 10.0:
				_collect()
				return
			global_position += dir.normalized() * speed * delta

	func _collect() -> void:
		var player_nodes := get_tree().get_nodes_in_group("player")
		if player_nodes.size() > 0:
			player_nodes[0].add_xp(xp_value)
		queue_free()

	func _draw() -> void:
		draw_circle(Vector2.ZERO, 6.0, Color(0.2, 1.0, 0.4))
