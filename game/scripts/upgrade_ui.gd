extends CanvasLayer

signal upgrade_chosen(upgrade_id: String)

var current_options: Array = []

@onready var panel: Panel = $Panel
@onready var title_label: Label = $Panel/VBox/Title
@onready var btn1: Button = $Panel/VBox/Btn1
@onready var btn2: Button = $Panel/VBox/Btn2
@onready var btn3: Button = $Panel/VBox/Btn3

func _ready() -> void:
	hide()
	if btn1:
		btn1.pressed.connect(_on_btn_pressed.bind(0))
	if btn2:
		btn2.pressed.connect(_on_btn_pressed.bind(1))
	if btn3:
		btn3.pressed.connect(_on_btn_pressed.bind(2))

func show_upgrades(options: Array) -> void:
	current_options = options
	var buttons := [btn1, btn2, btn3]
	for i in range(buttons.size()):
		if i < options.size():
			var opt: Dictionary = options[i]
			buttons[i].text = "%s\n%s" % [opt.get("name", ""), opt.get("description", "")]
			buttons[i].show()
		else:
			buttons[i].hide()
	show()

func _on_btn_pressed(index: int) -> void:
	if index < current_options.size():
		var opt: Dictionary = current_options[index]
		upgrade_chosen.emit(opt.get("id", ""))
	hide()

func get_current_options() -> Array:
	return current_options
