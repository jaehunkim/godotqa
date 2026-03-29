extends CanvasLayer

signal restart_requested

@onready var kills_label: Label = $Panel/VBox/KillsLabel
@onready var time_label: Label = $Panel/VBox/TimeLabel
@onready var level_label: Label = $Panel/VBox/LevelLabel
@onready var restart_btn: Button = $Panel/VBox/RestartBtn

func _ready() -> void:
	hide()
	if restart_btn:
		restart_btn.pressed.connect(_on_restart_pressed)

func show_game_over(kills: int, elapsed: float, level: int) -> void:
	if kills_label:
		kills_label.text = "Kills: %d" % kills
	if time_label:
		var mins := int(elapsed) / 60
		var secs := int(elapsed) % 60
		time_label.text = "Time: %02d:%02d" % [mins, secs]
	if level_label:
		level_label.text = "Level Reached: %d" % level
	show()

func _on_restart_pressed() -> void:
	restart_requested.emit()
