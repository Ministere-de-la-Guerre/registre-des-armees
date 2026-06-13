# NTW3 Staff-General Icon Placement

## Result

- Original source set: NTW3 v9.4 `cards94.pack`, `db.9401.pack`, and `txt.9401.pack`.
- Original staff-general icons extracted read-only: 374.
- Allowed staff-general placement rows: 573.
- Non-ToW corps placements: 323.
- ToW placements combined into one folder: 250.
- Original icons not referenced by an allowed corps or ToW row: 52.
- Placement rows missing an original icon: 0.
- Hash mismatches against the repository's earlier icon extraction: 0.

## Placement Rule

The exact corps assignment comes from `db/units_to_exclusive_faction_permissions_tables/units_to_exclusive_faction_permissions` using
`unit_key + faction_key` where `allowed=true`. The readable corps name comes from
`factions_screen_name_<faction_key>` in `NTW3/Version94/Data/txt.9401.pack:text/localisation.loc`. Staff-general units
do not carry `ACDV<division>B<brigade>` tags, so their recommended location is the
army-corps root rather than a division folder. ToW icons are kept together.

## Files

- Organized copies: `assets/staff_general_icons_by_corps/`
- Exact placement evidence: `reports/staff_general_corps_placement.csv`
- Root-level placement CSV: `staff_general_corps_placement.csv`
- Star-ready root CSV: `staff_general_corps_placement_with_stars.csv`
- Complete original icon inventory: `reports/staff_general_original_icon_inventory.csv`
- Raw read-only extraction copies: `source/original_ntw3_v94_staff_general_icons/`
