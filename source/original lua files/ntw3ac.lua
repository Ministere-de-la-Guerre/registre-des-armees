local NTW3 = require("ntw3")
local NTW3AC = {}

function NTW3AC.CapGenerals(faction)
  staffgen_max = 1
  if string.find(faction, "_ac_") == nil and string.find(faction, "_tow_") == nil then
    combatgen_max = 1
  else
    aux1 = NTW3.Explode("_", faction)
    aux2 = aux1[4]:match("%d+$")
    combatgen_max = 9 - tonumber(aux2)
  end
  return staffgen_max, combatgen_max
end

function NTW3AC.ACgenerals(faction, units)
  local max_nonfighting_gen, max_fighting_gen = NTW3AC.CapGenerals(faction)
  local max_gens = {
    max_nonfighting_gen,
    max_fighting_gen + 2
  }
  local generals = {
    {},
    {}
  }
  for _, general in ipairs(units) do
    if general.IsGeneral then
      if general.Men / 2 == 16 or general.Men / 2 == 61 then
        table.insert(generals[1], general)
      else
        table.insert(generals[2], general)
      end
    end
  end
  local generals_selected = {}
  for i = 1, 2 do
    local nb_gens = math.min(max_gens[i], #generals[i])
    NTW3.Shuffle(generals[i])
    for j = 1, nb_gens do
      table.insert(generals_selected, generals[i][j].Key)
    end
  end
  return generals_selected
end

function NTW3AC.ToWFgenerals(faction, units, corps_ids)
  local max_gens = {999, 4}
  local generals = {
    {},
    {}
  }
  for _, general in ipairs(units) do
    if general.IsGeneral then
      if general.Men / 2 == 16 or general.Men / 2 == 61 then
        table.insert(generals[1], general)
      else
        aux1 = NTW3.Explode("_", general.Key)
        if NTW3.InArray(aux1[4], corps_ids) then
          table.insert(generals[2], general)
        end
      end
    end
  end
  local generals_selected = {}
  for i = 1, 2 do
    local nb_gens = math.min(max_gens[i], #generals[i])
    NTW3.Shuffle(generals[i])
    for j = 1, nb_gens do
      table.insert(generals_selected, generals[i][j].Key)
    end
  end
  return generals_selected
end

function NTW3AC.ToWFarmycorps(faction, units)
  local corps_ids = {}
  local max_ac = 4
  for _, unit in ipairs(units) do
    if unit.IsGeneral and (unit.Men / 2 == 16 or unit.Men / 2 == 61) then
      local per = NTW3.Explode("_", unit.Key)
      local corp_id = per[4]
      if not NTW3.InArray(corp_id, corps_ids) then
        table.insert(corps_ids, corp_id)
      end
    end
  end
  if max_ac < table.getn(corps_ids) then
    NTW3.Shuffle(corps_ids)
    corps_ids = NTW3.ArraySlice(corps_ids, 1, max_ac)
  end
  return corps_ids
end

function NTW3AC.MaxBrigades()
  return 7
end

function NTW3AC.Divisions_Build(faction, units)
  local divisions = {}
  for i = 1, NTW3.Lobby_MaxLines() do
    divisions[i] = {}
    for j = 1, NTW3AC.MaxBrigades() do
      table.insert(divisions[i], {})
    end
  end
  local gen_selected = NTW3AC.ACgenerals(faction, units)
  for i, v in ipairs(units) do
    local valid = true
    if v.IsGeneral and not NTW3.InArray(v.Key, gen_selected) then
      valid = false
    end
    if valid then
      local n_division, n_brigade = NTW3.AC_DivisionBrigade_Locate(v.Description)
      if n_division == 0 or n_brigade == 0 then
        n_division = NTW3.Lobby_MaxLines()
        if v.Class == "General" and (v.Men / 2 == 16 or v.Men / 2 == 61) then
          n_division = 1
          n_brigade = 1
        elseif string.find(v.Key, "art_foot") ~= nil then
          n_brigade = 1
        elseif string.find(v.Key, "art_horse") ~= nil then
          n_brigade = 2
        elseif string.find(v.Key, "art_fixed") ~= nil then
          n_brigade = 3
        else
          n_brigade = 4
        end
      else
        n_division = n_division + 1
      end
      if 0 < n_division and 0 < n_brigade then
        n_division = math.min(n_division, NTW3.Lobby_MaxLines())
        n_brigade = math.min(n_brigade, NTW3AC.MaxBrigades())
        table.insert(divisions[n_division][n_brigade], v)
      end
    end
  end
  return divisions
end

return NTW3AC
