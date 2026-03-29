extends CharacterBody2D

signal died
signal xp_changed(current_xp: int, xp_to_next: int)
signal level_up(new_level: int)

const BASE_SPEED: float = 200.0
const BASE_FIRE_RATE: float = 0.5
const BASE_DAMAGE: float = 10.0
const BASE_HP: float = 100.0
const BASE_BULLET_COUNT: int = 1

var max_hp: float = BASE_HP
var current_hp: float = BASE_HP
var speed: float = BASE_SPEED
var fire_rate: float = BASE_FIRE_RATE
var damage: float = BASE_DAMAGE
var bullet_count: int = BASE_BULLET_COUNT
var magnet_range: float = 60.0
var hp_regen: float = 0.0

var current_xp: int = 0
var xp_to_next: int = 8
var level: int = 1

var shoot_timer: float = 0.0
var is_dead: bool = false

@onready var bullet_scene: PackedScene = preload("res://scenes/bullet.tscn")

func _ready() -> void:
	add_to_group("player")

func _physics_process(delta: float) -> void:
	if is_dead:
		return

	_handle_movement(delta)
	_handle_shooting(delta)
	_handle_regen(delta)
	_attract_xp_orbs()

func _handle_movement(_delta: float) -> void:
	var dir := Vector2.ZERO
	if Input.is_action_pressed("move_up"):
		dir.y -= 1
	if Input.is_action_pressed("move_down"):
		dir.y += 1
	if Input.is_action_pressed("move_left"):
		dir.x -= 1
	if Input.is_action_pressed("move_right"):
		dir.x += 1

	velocity = dir.normalized() * speed
	move_and_slide()

func _handle_shooting(delta: float) -> void:
	shoot_timer -= delta
	if shoot_timer > 0.0:
		return

	var target := _find_nearest_enemy()
	if target == null:
		return

	shoot_timer = fire_rate
	_fire_at(target)

func _find_nearest_enemy() -> Node2D:
	var enemies := get_tree().get_nodes_in_group("enemies")
	var nearest: Node2D = null
	var nearest_dist: float = INF
	for e in enemies:
		var d: float = global_position.distance_to(e.global_position)
		if d < nearest_dist:
			nearest_dist = d
			nearest = e
	return nearest

func _fire_at(target: Node2D) -> void:
	var dir := (target.global_position - global_position).normalized()
	var spread_step: float = PI / 8.0

	for i in range(bullet_count):
		var angle_offset: float = 0.0
		if bullet_count > 1:
			angle_offset = (i - (bullet_count - 1) / 2.0) * spread_step

		var bullet: Node = bullet_scene.instantiate()
		get_tree().get_root().get_node("Main").add_child(bullet)
		bullet.global_position = global_position
		bullet.setup(dir.rotated(angle_offset), damage)

func _handle_regen(delta: float) -> void:
	if hp_regen <= 0.0:
		return
	current_hp = minf(current_hp + hp_regen * delta, max_hp)

func _attract_xp_orbs() -> void:
	var orbs := get_tree().get_nodes_in_group("xp_orbs")
	for orb in orbs:
		if global_position.distance_to(orb.global_position) < magnet_range:
			if orb.has_method("attract"):
				orb.attract(global_position)

func take_damage(amount: float) -> void:
	if is_dead:
		return
	current_hp -= amount
	if current_hp <= 0.0:
		current_hp = 0.0
		_die()

func _die() -> void:
	is_dead = true
	died.emit()

func add_xp(amount: int) -> void:
	current_xp += amount
	xp_changed.emit(current_xp, xp_to_next)
	while current_xp >= xp_to_next:
		current_xp -= xp_to_next
		level += 1
		xp_to_next = int(xp_to_next * 1.1)
		level_up.emit(level)
		xp_changed.emit(current_xp, xp_to_next)

func apply_upgrade(upgrade_id: String) -> void:
	match upgrade_id:
		"damage":
			damage *= 1.25
		"speed":
			speed *= 1.15
		"fire_rate":
			fire_rate = maxf(fire_rate * 0.8, 0.1)
		"extra_projectile":
			bullet_count += 1
		"hp_regen":
			hp_regen += 2.0
		"magnet":
			magnet_range += 40.0

func get_hp() -> float:
	return current_hp

func _draw() -> void:
	# Player: blue square
	draw_rect(Rect2(-16, -16, 32, 32), Color(0.2, 0.5, 1.0))
	# Direction indicator
	draw_rect(Rect2(8, -4, 10, 8), Color(0.1, 0.3, 0.8))
