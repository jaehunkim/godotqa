extends CanvasLayer

@onready var hp_bar: ProgressBar = $HPBar
@onready var xp_bar: ProgressBar = $XPBar
@onready var level_label: Label = $LevelLabel
@onready var kill_label: Label = $KillLabel
@onready var time_label: Label = $TimeLabel

func update_hp(current: float, maximum: float) -> void:
	if hp_bar:
		hp_bar.max_value = maximum
		hp_bar.value = current

func update_xp(current: int, to_next: int) -> void:
	if xp_bar:
		xp_bar.max_value = to_next
		xp_bar.value = current

func update_level(lv: int) -> void:
	if level_label:
		level_label.text = "Level: %d" % lv

func update_kills(kills: int) -> void:
	if kill_label:
		kill_label.text = "Kills: %d" % kills

func update_time(seconds: float) -> void:
	if time_label:
		var mins := int(seconds) / 60
		var secs := int(seconds) % 60
		time_label.text = "%02d:%02d" % [mins, secs]
