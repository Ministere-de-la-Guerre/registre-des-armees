local NTW3 = {}

function NTW3.IniLoad(fileName)
  assert(type(fileName) == "string", "Parameter \"fileName\" must be a string.")
  local file = assert(io.open(fileName, "r"), "Error loading file : " .. fileName)
  local data = {}
  local section
  for line in file:lines() do
    local tempSection = line:match("^%[([^%[%]]+)%]$")
    if tempSection then
      section = tonumber(tempSection) and tonumber(tempSection) or tempSection
      data[section] = data[section] or {}
    end
    local param, value = line:match("^([%w|_]+)%s-=%s-(.+)$")
    if param and value ~= nil then
      if tonumber(value) then
        value = tonumber(value)
      elseif value == "true" then
        value = true
      elseif value == "false" then
        value = false
      end
      if tonumber(param) then
        param = tonumber(param)
      end
      data[section][param] = value
    end
  end
  file:close()
  return data
end

function NTW3.IniSave(fileName, data)
  assert(type(fileName) == "string", "Parameter \"fileName\" must be a string.")
  assert(type(data) == "table", "Parameter \"data\" must be a table.")
  local file = assert(io.open(fileName, "w+b"), "Error loading file :" .. fileName)
  local contents = ""
  for section, param in pairs(data) do
    contents = contents .. ("[%s]\n"):format(section)
    for key, value in pairs(param) do
      contents = contents .. ("%s=%s\n"):format(key, tostring(value))
    end
    contents = contents .. "\n"
  end
  file:write(contents)
  file:close()
end

function NTW3.MaxUnits()
  return 31
end

function NTW3.CapTypeUnit(type)
  if type == "art_foot" then
    return 2
  elseif type == "art_horse" then
    return 1
  elseif type == "cav_heavy" then
    return 10
  else
    return 0
  end
end

function NTW3.Lobby_MaxLines()
  return 8
end

function NTW3.FactionIsGermanStates(faction)
  aux1 = NTW3.Explode("_", faction)
  return #aux1 >= 4 and string.find(aux1[4], "g") ~= nil
end

function NTW3.FactionIsRussia(faction)
  aux1 = NTW3.Explode("_", faction)
  return #aux1 >= 4 and string.find(aux1[4], "r") ~= nil
end

function NTW3.FactionIsPrussia(faction)
  aux1 = NTW3.Explode("_", faction)
  return #aux1 >= 4 and string.find(aux1[4], "p") ~= nil
end

function NTW3.FactionMenu_ToWs()
  return {
    {
      "04",
      "1798-1801",
      "\195\137gypte",
      "Egypt"
    },
    {
      "03",
      "1798-1800",
      "Rhin-Italie",
      "2nd Coalition"
    },
    {
      "15",
      "1804-1813",
      "Liberation war",
      "Subjugation"
    },
    {
      "05",
      "1805",
      "Allemagne",
      "3rd Coalition"
    },
    {
      "06",
      "1806-1807",
      "Prusse",
      "4th Coalition"
    },
    {
      "07",
      "1808-1809",
      "Finlyandiya",
      "Finska"
    },
    {
      "08",
      "1809",
      "Autriche",
      "5th Coalition"
    },
    {
      "09",
      "1809",
      "Espagne",
      "Peninsular war"
    },
    {
      "13",
      "1811",
      "Espagne",
      "Peninsular war"
    },
    {
      "10",
      "1812",
      "War of 1812",
      "War of 1812"
    },
    {
      "11",
      "1812",
      "Russie",
      "Patriotic war"
    },
    {
      "17",
      "1814",
      "France",
      "France"
    },
    {
      "14",
      "1815",
      "Napoli",
      "Italien"
    },
    {
      "12",
      "1815",
      "Cent-Jours",
      "Hundred days"
    }
  }
end

function NTW3.FactionMenu(imperial)
  local acgroups = NTW3.FactionMenu_ToWs()
  local tow_factions = {
    {
      {
        "*TH\195\137\195\130TRES DE GUERRE"
      },
      {"ntw3_tow_a"},
      {"ntw3_tow_c"}
    },
    {
      {
        "*THEATRES OF WAR"
      },
      {"ntw3_tow_b"}
    }
  }
  local custom_factions = {
    {
      {
        "*ARM\195\137ES COMPL\195\136TES"
      },
      {
        "france",
        "denmark",
        "aaa_lordz"
      }
    },
    {
      {
        "*Custom armies"
      },
      {
        "ntw3_hre",
        "piedmont_savoy",
        "britain",
        "sardinia",
        "aaa_lordz"
      }
    }
  }
  local menu = {}
  local idx, suffix
  if imperial then
    idx = 3
    suffix = "a"
  else
    idx = 4
    suffix = "b"
  end
  for _, ToW in ipairs(acgroups) do
    table.insert(menu, {
      {
        "*" .. ToW[idx] .. " (" .. ToW[2] .. ")"
      },
      {
        "ntw3_ac_" .. suffix .. ToW[1] .. "_"
      }
    })
  end
  table.insert(menu, tow_factions[idx - 2])
  table.insert(menu, custom_factions[idx - 2])
  return menu
end

function NTW3.FactionsINI_Path()
  return "data/NTW3/Temp/xam.pack"
end

function NTW3.FactionsINI_Save(Factions)
  local dirpath = "data\\ui\\flags\\"
  local dirpathlen = string.len(dirpath)
  local file = io.open(NTW3.FactionsINI_Path(), "w+b")
  for _, Faction in pairs(Factions) do
    file:write(Faction.Key .. "=" .. string.sub(Faction.FlagPath, dirpathlen + 1) .. "=" .. Faction.Name .. "\n")
  end
  file:close()
end

function NTW3.FactionsINI_Load()
  local dirpath = "data\\ui\\flags\\"
  local file = io.open(NTW3.FactionsINI_Path(), "r")
  local T = {}
  for line in file:lines() do
    local aux = NTW3.Explode("=", line)
    table.insert(T, {
      Key = aux[1],
      FlagDir = dirpath .. aux[2],
      Name = aux[3]
    })
  end
  file:close()
  return T
end

function NTW3.PostBattleName(name, flagpath, Factions)
  if string.find(flagpath, "_ac") == nil and string.find(flagpath, "_tow") == nil or string.find(name, "\n") ~= nil then
    return name
  end
  local ToWs = NTW3.FactionMenu_ToWs()
  for i, Faction in ipairs(Factions) do
    if Faction.FlagDir == flagpath then
      if string.find(flagpath, "_ac") ~= nil then
        local aux1 = NTW3.Explode("_", Faction.Key)
        local aux2 = NTW3.ArraySlice(aux1, 1, #aux1 - 1)
        local aux3 = NTW3.Implode("_", aux2)
        for _, ToW in ipairs(ToWs) do
          for __, Alliance in ipairs(ToW) do
            if aux3 == Alliance[2] then
              local aux4 = NTW3.Explode("/", Faction.Name)
              local aux5 = NTW3.Explode(".", aux4[1])
              local aux6 = string.sub(aux5[2], 2)
              local aux7 = NTW3.Explode("(", Alliance[1])
              return name .. "\n" .. aux7[1] .. "\n" .. aux6 .. "(" .. aux5[1] .. ")"
            end
          end
        end
      elseif string.find(flagpath, "_tow") ~= nil then
        local aux4 = NTW3.Explode("/", Faction.Name)
        local aux5 = NTW3.Explode(".", aux4[1])
        local aux6 = string.sub(aux5[2], 2)
        return name .. "\n" .. Faction.Name
      end
    end
  end
  return name
end

function NTW3.GetTOWfromFactionID(faction)
  if string.find(faction, "_ac_") ~= nil then
    local per = NTW3.Explode("_", faction)
    return per[3]
  else
    return nil
  end
end

function NTW3.GetTOWfromTowFactionID(faction)
  if string.find(faction, "_tow_") ~= nil then
    local per = NTW3.Explode("_", faction)
    return per[4]
  else
    return nil
  end
end

function NTW3.Factions_Points_Display(factions, teams, pretext, faction_new, army_index)
  if string.len(faction_new) > 0 then
    for alliance, players in ipairs(teams) do
      for num, Player in ipairs(players) do
        if Player.Slot == army_index then
          teams[alliance][num].Faction = faction_new
        end
      end
    end
  end
  local FactionErrors = NTW3.Factions_Errors(teams)
  if 0 < #FactionErrors then
    return FactionErrors[1]
  end
  return pretext .. ", factions: " .. NTW3.Implode("-", NTW3.Factions_Points_Sums(factions, teams, faction_new, army_index))
end

function NTW3.Factions_Points_Sums(factions, teams, faction_new, army_index)
  local factionpoints = {0, 0}
  for alliance, players in ipairs(teams) do
    for num, Player in ipairs(players) do
      factionpoints[alliance] = factionpoints[alliance] + NTW3.Faction_Points(factions, Player.Faction)
    end
  end
  return factionpoints
end

function NTW3.Faction_Points(factions, faction_slc)
  for _, Faction in ipairs(factions) do
    if Faction.Key == faction_slc then
      local data = NTW3.Explode(". ", Faction.Name)
      local val = tonumber(data[1])
      return val <= 1 and 0 or val
    end
  end
end

function NTW3.Factions_Errors(teams)
  local Alliances = {
    {
      Customs = {},
      ToWs = {}
    },
    {
      Customs = {},
      ToWs = {}
    }
  }
  for alliance, players in ipairs(teams) do
    for num, Player in ipairs(players) do
      if Player.Faction ~= "aaa_lordz" then
        local ToW = NTW3.GetTOWfromFactionID(Player.Faction)
        local PlayerName = string.len(Player.Name) == 0 and "???" or Player.Name
        if ToW == nil then
          table.insert(Alliances[alliance].Customs, Player.Faction)
        else
          if Alliances[alliance].ToWs[ToW] == nil then
            Alliances[alliance].ToWs[ToW] = {}
          end
          if Alliances[alliance].ToWs[ToW][Player.Faction] == nil then
            Alliances[alliance].ToWs[ToW][Player.Faction] = {}
          end
          table.insert(Alliances[alliance].ToWs[ToW][Player.Faction], PlayerName)
        end
      end
    end
  end
  local Errors = {}
  for alliance, Team in ipairs(Alliances) do
    if 0 < NTW3.Count(Team.Customs) and 0 < NTW3.Count(Team.ToWs) then
      table.insert(Errors, "Alliance " .. tostring(alliance) .. " must not mix custom and corps")
    end
    if NTW3.Count(Team.ToWs) >= 2 then
      table.insert(Errors, "Alliance " .. tostring(alliance) .. " must not mix different theaters of war")
    end
    for _, ToW in pairs(Team.ToWs) do
      for __, Players in pairs(ToW) do
        if 2 <= #Players then
          table.insert(Errors, NTW3.Implode(" and ", Players) .. " must not pick the same corps")
        end
      end
    end
  end
  return Errors
end

function NTW3.Faction_Units_List(faction)
  local roster = {}
  for i, ctg in ipairs({
    1,
    2,
    4
  }) do
    local units_perctg = FrontEnd.RecruitableUnits(faction, false, 2, ctg, 10000, true, 1)
    for j, unit in ipairs(units_perctg) do
      table.insert(roster, unit)
    end
  end
  return roster
end

function NTW3.ArmyPrice(faction, cards)
  local S = 0
  for i, v in ipairs(cards) do
    S = S + v.MPCost
  end
  if string.find(faction, "_ac_") ~= nil then
    S = S - NTW3.AC_DivisionBrigade_Bonus(faction, cards)
  end
  return S
end

function NTW3.Custom_Group_Locate(dsc)
  local _, x = string.find(dsc, "CGRP")
  if x ~= nil then
    local group = string.sub(dsc, x + 1)
    return tonumber(group)
  else
    return 10
  end
end

function NTW3.AC_DivisionBrigade_Locate(dsc)
  local _, x = string.find(dsc, "ACDV")
  if x ~= nil then
    local divbgd = string.sub(dsc, x + 1)
    local vals = NTW3.Explode("B", divbgd)
    return tonumber(vals[1]), tonumber(vals[2])
  else
    return 0, 0
  end
end

function NTW3.AC_DivisionBrigade_Bonus(faction, cards)
  local cut = 0
  local ratio = 1
  if NTW3.FactionIsGermanStates(faction) then
    ratio = ratio * 1.5
  end
  local RosterDivisions = NTW3.AC_DivisionBrigade_Roster(faction)
  local SelectedDivisions = NTW3.AC_DivisionBrigade_Selected(cards)
  for n_division, SelectedDivision in pairs(SelectedDivisions) do
    local RosterDivision = RosterDivisions[n_division]
    if SelectedDivision.NbUnits >= RosterDivision.NbUnits then
      cut = cut + NTW3.AC_DivisionBrigade_PriceCut(RosterDivision)
    else
      for n_brigade, SelectedBrigade in pairs(SelectedDivision.Brigades) do
        local RosterBrigade = RosterDivision.Brigades[n_brigade]
        if SelectedBrigade.NbUnits >= RosterBrigade.NbUnits then
          cut = cut + NTW3.AC_DivisionBrigade_PriceCut(RosterBrigade)
        end
      end
    end
  end
  return math.floor(cut * ratio)
end

function NTW3.AC_DivisionBrigade_PriceCut(Group)
  return math.floor(Group.Cost / 100 * (Group.NbUnits - 1))
end

function NTW3.AC_DivisionBrigade_Roster(faction)
  local RosterUnits = NTW3.Faction_Units_List(faction)
  local RosterDivisions = {}
  for i, v in ipairs(RosterUnits) do
    if v.Class ~= "General" then
      local n_division, n_brigade = NTW3.AC_DivisionBrigade_Locate(v.Description)
      if 0 < n_division and 0 < n_brigade then
        if RosterDivisions[n_division] == nil then
          RosterDivisions[n_division] = {
            Cost = 0,
            NbUnits = 0,
            Brigades = {}
          }
        end
        if RosterDivisions[n_division].Brigades[n_brigade] == nil then
          RosterDivisions[n_division].Brigades[n_brigade] = {Cost = 0, NbUnits = 0}
        end
        RosterDivisions[n_division].Cost = RosterDivisions[n_division].Cost + v.Cap * v.MPCost
        RosterDivisions[n_division].NbUnits = RosterDivisions[n_division].NbUnits + v.Cap
        RosterDivisions[n_division].Brigades[n_brigade].Cost = RosterDivisions[n_division].Brigades[n_brigade].Cost + v.Cap * v.MPCost
        RosterDivisions[n_division].Brigades[n_brigade].NbUnits = RosterDivisions[n_division].Brigades[n_brigade].NbUnits + v.Cap
      end
    end
  end
  return RosterDivisions
end

function NTW3.AC_DivisionBrigade_Selected(cards)
  local SelectedDivisions = {}
  for i, v in ipairs(cards) do
    local n_division, n_brigade = NTW3.AC_DivisionBrigade_Locate(v.Description)
    if 0 < n_division and 0 < n_brigade then
      if SelectedDivisions[n_division] == nil then
        SelectedDivisions[n_division] = {
          NbUnits = 0,
          Brigades = {}
        }
      end
      if SelectedDivisions[n_division].Brigades[n_brigade] == nil then
        SelectedDivisions[n_division].Brigades[n_brigade] = {NbUnits = 0}
      end
      SelectedDivisions[n_division].NbUnits = SelectedDivisions[n_division].NbUnits + 1
      SelectedDivisions[n_division].Brigades[n_brigade].NbUnits = SelectedDivisions[n_division].Brigades[n_brigade].NbUnits + 1
    end
  end
  return SelectedDivisions
end

function NTW3.UnitsExclusions()
  return {
    {
      "ntw3_france1806",
      "Ntw3_Cav_Light_France1806_5_Lauzun_Gen1",
      {
        "Ntw3_Cav_Light_France1806_5_Lauzun",
        "Ntw3_Cav_Light_France1806_7_Toujourspresents"
      }
    },
    {
      "ntw3_corp_fr1806_b",
      "Ntw3_Cav_Light_Corp_fr1806_b_5_Lauzun_Gen1",
      {
        "Ntw3_Cav_Light_Corp_fr1806_b_5_Lauzun",
        "Ntw3_Cav_Light_Corp_fr1806_b_5_Lauzun_Gen2",
        "Ntw3_Cav_Light_Corp_fr1806_b_7_Toujourspresents",
        "Ntw3_Cav_Light_Corp_fr1806_b_7_Toujourspresents_Gen1"
      }
    },
    {
      "ntw3_corp_fr1806_e",
      "Ntw3_Art_Foot_Corp_fr1806_e_8pX_Gen1",
      {
        "Ntw3_Art_Foot_Corp_fr1806_e_8p",
        "Ntw3_Art_Foot_Corp_fr1806_e_8pX"
      }
    },
    {
      "britain",
      "Ntw3_Cav_Light_Britain_Queen_16_Scarlet_Gen1",
      {
        "Ntw3_Cav_Light_Britain_Prince_12_Supple",
        "Ntw3_Cav_Light_Britain_Queen_16_Scarlet"
      }
    },
    {
      "poland_lithuania",
      "Ntw3_Cav_Light_Poland_Huzarzy_10_Zeoty_Gen1",
      {
        "Ntw3_Cav_Light_Poland_Huzarzy_10_Zeoty",
        "Ntw3_Cav_Light_Poland_Huzarzy_13_Srebrini"
      }
    },
    {
      "ntw3_corp_ru1812_a",
      "Ntw3_Art_Foot_Corp_ru1812_a_12p_Gen1",
      {
        "Ntw3_Art_Foot_Corp_ru1812_a_12p_Gen2"
      }
    },
    {
      "ntw3_corp_fr1805_e",
      "Ntw3_Cav_Medium_Gen_Corp_fr1805_e_Frederic_Walr",
      {
        "Ntw3_Cav_Medium_Corp_fr1805_e_13_Blancs_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_13_Blancs",
        "Ntw3_Cav_Medium_Corp_fr1805_e_3_Bourbondragons_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_3_Bourbondragons",
        "Ntw3_Cav_Medium_Corp_fr1805_e_10_Tesse_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_10_Tesse",
        "Ntw3_Cav_Medium_Corp_fr1805_e_11_Angouleme_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_11_Angouleme",
        "Ntw3_Cav_Medium_Corp_fr1805_e_22_Affaire_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_22_Affaire",
        "Ntw3_Cav_Medium_Corp_fr1805_e_6_Reine_Gen1",
        "Ntw3_Cav_Medium_Corp_fr1805_e_6_Reine"
      }
    }
  }
end

function NTW3.Log(txt)
  local file = io.open("ntw3_log.txt", "a+")
  if type(txt) == "string" then
    file:write(txt .. "\n")
  else
    file:write(NTW3.DumpVar(txt) .. "\n")
  end
  file:close()
end

function NTW3.DumpVar(data)
  local tablecache = {}
  local buffer = ""
  local padder = "    "
  
  local function _dumpvar(d, depth)
    local t = type(d)
    local str = tostring(d)
    if t == "table" then
      if tablecache[str] then
        buffer = buffer .. "<" .. str .. ">\n"
      else
        tablecache[str] = (tablecache[str] or 0) + 1
        buffer = buffer .. "(" .. str .. ") {\n"
        for k, v in pairs(d) do
          buffer = buffer .. string.rep(padder, depth + 1) .. "[" .. k .. "] => "
          _dumpvar(v, depth + 1)
        end
        buffer = buffer .. string.rep(padder, depth) .. "}\n"
      end
    elseif t == "number" then
      buffer = buffer .. "(" .. t .. ") " .. str .. "\n"
    else
      buffer = buffer .. "(" .. t .. ") \"" .. str .. "\"\n"
    end
  end
  
  _dumpvar(data, 0)
  return buffer
end

function NTW3.Explode(sep, inputstr)
  local t = {}
  for str in string.gmatch(inputstr, "([^" .. sep .. "]+)") do
    table.insert(t, str)
  end
  return t
end

function NTW3.Implode(sep, list)
  local len = #list
  if len == 0 then
    return ""
  end
  local string = tostring(list[1])
  for i = 2, len do
    string = string .. sep .. tostring(list[i])
  end
  return string
end

function NTW3.InArray(needle, haystack)
  for i, x in ipairs(haystack) do
    if x == needle then
      return true
    end
  end
  return false
end

function NTW3.Shuffle(tbl)
  local seed1 = tonumber(os.date("%d%m"))
  local seed2 = math.floor(tonumber(os.date("%H") / 2.8))
  local seed = seed2 * 10000 + seed1
  math.randomseed(seed)
  for i = 1, 5 do
    math.random(1, 100)
  end
  for i = #tbl, 2, -1 do
    local j = math.random(1, i)
    tbl[i], tbl[j] = tbl[j], tbl[i]
  end
  return tbl
end

function NTW3.Count(tbl)
  local count = 0
  for _ in pairs(tbl) do
    count = count + 1
  end
  return count
end

function NTW3.ArraySlice(tbl, first, last)
  local sliced = {}
  for i = first, last or #tbl do
    table.insert(sliced, tbl[i])
  end
  return sliced
end

return NTW3
