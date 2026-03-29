extends Node

var enemy_scene: PackedScene = null
var spawn_interval: float = 2.2
var spawn_timer: float = 0.0
var difficulty_timer: float = 0.0
var difficulty_level: int = 1

var viewport_size: Vector2 = Vector2(1280, 720)
var spawn_margin: float = 50.0

var base_enemy_hp: float = 30.0
var base_enemy_speed: float = 80.0
var base_enemy_damage: float = 8.0

var enemies_container: Node = null

func _ready() -> void:
	enemy_scene = preload("res://scenes/enemy.tscn")

func setup(container: Node) -> void:
	enemies_container = container

func _process(delta: float) -> void:
	spawn_timer -= delta
	difficulty_timer += delta

	# Increase difficulty every 15 seconds
	if difficulty_timer >= 15.0:
		difficulty_timer = 0.0
		difficulty_level += 1
		spawn_interval = maxf(spawn_interval * 0.90, 0.3)

	if spawn_timer <= 0.0:
		spawn_timer = spawn_interval
		_spawn_wave()

func _spawn_wave() -> void:
	var count: int = 1 + int(difficulty_level * 0.5)
	for i in range(count):
		_spawn_enemy()

func _spawn_enemy() -> void:
	if enemy_scene == null or enemies_container == null:
		return

	var pos := _get_spawn_position()
	var enemy: Node = enemy_scene.instantiate()
	enemies_container.add_child(enemy)
	enemy.global_position = pos

	# Scale stats with difficulty
	var hp_scale: float = 1.0 + (difficulty_level - 1) * 0.2
	var speed_scale: float = 1.0 + (difficulty_level - 1) * 0.1
	var xp_val: int = max(1, difficulty_level)

	# Vary enemy types by difficulty
	var col: Color
	var type_roll := randi_range(0, 2)
	if type_roll == 0:
		col = Color(1.0, 0.2, 0.2)  # Basic red
	elif type_roll == 1:
		col = Color(0.8, 0.1, 0.8)  # Purple - faster
		speed_scale *= 1.3
		hp_scale *= 0.7
	else:
		col = Color(0.8, 0.5, 0.1)  # Orange - tankier
		hp_scale *= 1.5
		speed_scale *= 0.8
		xp_val *= 2

	if enemy.has_method("setup"):
		enemy.setup(
			base_enemy_hp * hp_scale,
			base_enemy_speed * speed_scale,
			base_enemy_damage,
			xp_val,
			col
		)

	if enemy.has_method("connect"):
		enemy.died.connect(_on_enemy_died)

func _on_enemy_died(_pos: Vector2, _xp: int) -> void:
	pass  # Handled by main.gd via signal on each enemy

func _get_spawn_position() -> Vector2:
	var vp := get_viewport()
	if vp:
		viewport_size = vp.get_visible_rect().size

	var side := randi_range(0, 3)
	match side:
		0:  # Top
			return Vector2(randf_range(0, viewport_size.x), -spawn_margin)
		1:  # Bottom
			return Vector2(randf_range(0, viewport_size.x), viewport_size.y + spawn_margin)
		2:  # Left
			return Vector2(-spawn_margin, randf_range(0, viewport_size.y))
		3:  # Right
			return Vector2(viewport_size.x + spawn_margin, randf_range(0, viewport_size.y))
	return Vector2.ZERO
