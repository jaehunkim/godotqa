extends Node2D

# Draws a subtle grid for visual reference
func _draw() -> void:
	var color := Color(0.15, 0.15, 0.22, 1.0)
	var step := 64.0
	# Vertical lines
	var x := 0.0
	while x <= 1280.0:
		draw_line(Vector2(x, 0), Vector2(x, 720), color, 1.0)
		x += step
	# Horizontal lines
	var y := 0.0
	while y <= 720.0:
		draw_line(Vector2(0, y), Vector2(1280, y), color, 1.0)
		y += step
