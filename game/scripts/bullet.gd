extends Area2D

var direction: Vector2 = Vector2.RIGHT
var speed: float = 500.0
var damage: float = 10.0
var lifetime: float = 2.0
var elapsed: float = 0.0

func setup(dir: Vector2, dmg: float) -> void:
	direction = dir
	damage = dmg

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _process(delta: float) -> void:
	global_position += direction * speed * delta
	elapsed += delta
	if elapsed >= lifetime:
		queue_free()

func _on_body_entered(body: Node) -> void:
	if body.is_in_group("enemies"):
		if body.has_method("take_damage"):
			body.take_damage(damage)
		queue_free()

func _draw() -> void:
	draw_circle(Vector2.ZERO, 5.0, Color(1.0, 1.0, 0.2))
