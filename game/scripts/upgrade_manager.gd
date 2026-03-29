extends Node

const UPGRADES := [
	{
		"id": "damage",
		"name": "Damage Up",
		"description": "Increase projectile damage by 25%"
	},
	{
		"id": "speed",
		"name": "Speed Up",
		"description": "Increase movement speed by 15%"
	},
	{
		"id": "fire_rate",
		"name": "Fire Rate Up",
		"description": "Shoot 20% faster"
	},
	{
		"id": "extra_projectile",
		"name": "Extra Projectile",
		"description": "Fire one additional projectile"
	},
	{
		"id": "hp_regen",
		"name": "HP Regen",
		"description": "Regenerate 2 HP per second"
	},
	{
		"id": "magnet",
		"name": "Magnet Range",
		"description": "Increase XP pickup range by 40"
	}
]

var upgrade_counts: Dictionary = {}

func _ready() -> void:
	for upg in UPGRADES:
		upgrade_counts[upg["id"]] = 0

func get_random_options(count: int = 3) -> Array:
	var pool := UPGRADES.duplicate()
	pool.shuffle()
	var result := []
	for i in range(mini(count, pool.size())):
		result.append(pool[i])
	return result

func apply_upgrade(upgrade_id: String, player: Node) -> void:
	if player == null:
		return
	if player.has_method("apply_upgrade"):
		player.apply_upgrade(upgrade_id)
	if upgrade_id in upgrade_counts:
		upgrade_counts[upgrade_id] += 1

func get_upgrades_dict() -> Dictionary:
	var result := {}
	for upg in UPGRADES:
		var uid: String = upg["id"]
		result[upg["name"]] = upgrade_counts.get(uid, 0)
	return result
