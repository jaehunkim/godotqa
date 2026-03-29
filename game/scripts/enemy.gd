extends CharacterBody2D

signal died(position: Vector2, xp_value: int)

var max_hp: float = 30.0
var current_hp: float = 30.0
var speed: float = 80.0
var damage: float = 10.0
var xp_value: int = 2
var color: Color = Color(1.0, 0.2, 0.2)

var player_ref: Node2D = null
var damage_cooldown: float = 0.0
const DAMAGE_INTERVAL: float = 0.5

func _ready() -> void:
	add_to_group("enemies")
	player_ref = get_tree().get_first_node_in_group("player")

func setup(hp: float, spd: float, dmg: float, xp: int, col: Color) -> void:
	max_hp = hp
	current_hp = hp
	speed = spd
	damage = dmg
	xp_value = xp
	color = col
	queue_redraw()

func _physics_process(delta: float) -> void:
	if player_ref == null:
		player_ref = get_tree().get_first_node_in_group("player")
	if player_ref == null:
		return

	var dir := (player_ref.global_position - global_position).normalized()
	velocity = dir * speed
	move_and_slide()

	# Damage player on contact with cooldown
	damage_cooldown -= delta
	if damage_cooldown <= 0.0:
		var dist := global_position.distance_to(player_ref.global_position)
		if dist < 28.0:  # player half-size (16) + enemy radius (14) = ~30
			if player_ref.has_method("take_damage"):
				player_ref.take_damage(damage)
			damage_cooldown = DAMAGE_INTERVAL

func take_damage(amount: float) -> void:
	current_hp -= amount
	queue_redraw()
	if current_hp <= 0.0:
		_die()

func _die() -> void:
	died.emit(global_position, xp_value)
	queue_free()

func _draw() -> void:
	# Enemy: colored diamond/circle shape
	var size: float = 14.0
	draw_circle(Vector2.ZERO, size, color)
	# HP bar above
	var bar_width: float = 28.0
	var bar_height: float = 4.0
	var bar_x: float = -bar_width / 2.0
	var bar_y: float = -size - 8.0
	draw_rect(Rect2(bar_x, bar_y, bar_width, bar_height), Color(0.3, 0.0, 0.0))
	var hp_frac: float = current_hp / max_hp
	draw_rect(Rect2(bar_x, bar_y, bar_width * hp_frac, bar_height), Color(1.0, 0.0, 0.0))
