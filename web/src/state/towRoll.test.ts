import { describe, expect, it } from "vitest";
import type { UnitCard } from "../domain/types";
import { makeRoster, makeUnit } from "../test/factories";
import { type BuildState, indexRoster, makeInstanceId } from "./build";
import { shuffleByDate } from "./rotation";
import {
  findTowBuildRollTime,
  findTowCorpsCombinationTime,
  isCardOverCorpsCeiling,
  isLegacyTowCombatGeneral,
  isLegacyTowStaffGeneral,
  rollTowArmy,
  rollTowGeneralKeys,
  rollTowSourceCorpsIds,
  towCombatGeneralKeysInBuild,
  towCorpsCeiling,
  towSourceCorpsIdsInBuild,
  towSourceCorpsPool,
} from "./towRoll";

function buildOf(unitKeys: string[], staffSlotUnitKey: string | null = null): BuildState {
  return {
    instances: unitKeys.map((unitKey) => ({ id: makeInstanceId(), unitKey })),
    staffSlotUnitKey,
  };
}

function towUnit(sourceId: string, suffix: string, partial: Partial<UnitCard> = {}) {
  const unitKey = partial.unitKey ?? `ntw3_inf_line_${sourceId}_001_${suffix}_tow_032`;
  return makeUnit({
    unitKey,
    factionKey: "ntw3_tow_a03_x8_032",
    towSourceCorpsId: sourceId,
    placement: null,
    placementSource: "tow_source_corps",
    ...partial,
  });
}

function staff(sourceId: string, label = "0001") {
  return towUnit(sourceId, `staff_${label}`, {
    unitKey: `ntw3_gen_staff_${sourceId}_0_${label}_tow_032`,
    isGeneral: true,
    generalKind: "staff",
    menRaw: 32,
    unitClass: "general",
  });
}

function combat(sourceId: string, label = "0001") {
  return towUnit(sourceId, `combat_${label}`, {
    unitKey: `ntw3_inf_line_${sourceId}_001_${label}_tow_032_com_${label}`,
    isGeneral: true,
    generalKind: "combat",
    menRaw: 160,
    unitClass: "general",
  });
}

describe("legacy TOW general classification", () => {
  it("treats domain staff generals and raw Men/2 markers as staff", () => {
    expect(isLegacyTowStaffGeneral(staff("081"))).toBe(true);
    expect(isLegacyTowStaffGeneral(towUnit("082", "raw_staff", { isGeneral: true, generalKind: null, menRaw: 122 }))).toBe(true);
    expect(isLegacyTowCombatGeneral(combat("083"))).toBe(true);
    expect(isLegacyTowCombatGeneral(towUnit("084", "plain", { isGeneral: false }))).toBe(false);
  });
});

describe("towSourceCorpsPool", () => {
  it("uses only staff generals and deduplicates source corps ids in first-seen order", () => {
    const cards = [
      combat("099"),
      staff("081", "a"),
      towUnit("081", "line"),
      staff("082", "b"),
      staff("081", "c"),
      staff("083", "d"),
    ];
    expect(towSourceCorpsPool(cards)).toEqual(["081", "082", "083"]);
  });
});

describe("Russie-Centre in-game calibration (ntw3_tow_a11_x8_028)", () => {
  // Real staff-general roster for the "[1812] 11. France (Russie-Centre)" theatre:
  // [sourceCorpsId, cost, rosterIndex]. The shuffle-input pool is these staff
  // generals in recruitOrder (cost asc, rosterIndex tiebreak), deduped to source
  // corps first-seen -> [124,130,131,120,121,119,117]. Provided in scrambled input
  // order to prove the pool ordering is derived, not taken from roster order.
  const staffGens = [
    staff("120", "0156"), // Eugène          cost 255 idx 516
    staff("130", "0619"), // Lefebvre        cost  55 idx 517
    staff("124", "0160"), // Junot           cost  55 idx 522
    staff("130", "0168"), // Bessières       cost 145 idx 523
    staff("131", "0170"), // Murat           cost 145 idx 525
    staff("124", "0618"), // Jérôme Bonaparte cost   1 idx 526
    staff("121", "0157"), // Poniatowski     cost 381 idx 527
    staff("117", "0153"), // Davout          cost 674 idx 529
    staff("119", "0155"), // Ney             cost 522 idx 531
    staff("130", "0169"), // Napoléon        cost 674 idx 532
    staff("130", "0167"), // Mortier         cost 255 idx 534
  ].map((c, i) => ({ ...c, cost: [255, 55, 55, 145, 145, 1, 381, 674, 522, 674, 255][i], rosterIndex: [516, 517, 522, 523, 525, 526, 527, 529, 531, 532, 534][i] }));

  it("derives the source-corps pool in recruitOrder, not roster order", () => {
    expect(towSourceCorpsPool(staffGens)).toEqual(["124", "130", "131", "120", "121", "119", "117"]);
  });

  // Every roll the user observed in game, exact ordered output. Windows are three
  // hours apart; the seed is floor(hour/2.8)*10000 + ddmm (unchanged from before).
  it.each([
    ["Jul 1 22:00", new Date(2026, 6, 1, 22), ["131", "119", "117", "120"]],
    ["Jul 2 01:00", new Date(2026, 6, 2, 1), ["117", "120", "124", "121"]],
    ["Jul 2 04:00", new Date(2026, 6, 2, 4), ["130", "119", "117", "131"]],
    ["Jul 2 07:00", new Date(2026, 6, 2, 7), ["124", "131", "117", "130"]],
    ["Jul 2 10:00", new Date(2026, 6, 2, 10), ["124", "121", "120", "117"]],
    ["Jul 2 13:00", new Date(2026, 6, 2, 13), ["131", "117", "121", "119"]],
    ["Jul 2 16:00", new Date(2026, 6, 2, 16), ["119", "120", "131", "130"]],
    ["Jul 2 19:00", new Date(2026, 6, 2, 19), ["121", "120", "117", "124"]],
    ["Jul 2 22:00", new Date(2026, 6, 2, 22), ["131", "117", "130", "119"]],
  ])("matches the in-game roll at %s", (_label, at, expected) => {
    expect(rollTowSourceCorpsIds(staffGens, at as Date)).toEqual(expected);
  });
});

describe("Espagne in-game calibration (ntw3_tow_a09_x8_021)", () => {
  // The engine's equal-cost tie-break inside FrontEnd.RecruitableUnits is not
  // visible in Lua or the exported TSVs. These nine ordered in-game windows
  // uniquely determine this theatre's pre-shuffle source-corps pool.
  const staffGens = [
    staff("140", "0182"),
    staff("146", "0190"),
    staff("142", "0186"),
    staff("147", "0191"),
    staff("148", "0194"),
    staff("147", "0192"),
    staff("145", "0189"),
    staff("141", "0183"),
    staff("144", "0188"),
    staff("143", "0187"),
  ].map((c, i) => ({
    ...c,
    factionKey: "ntw3_tow_a09_x8_021",
    unitKey: [
      "ntw3_gen_staff_140_3_0182_tow_021",
      "ntw3_gen_staff_146_3_0190_tow_021",
      "ntw3_gen_staff_142_2_0186_tow_021",
      "ntw3_gen_staff_147_4_0191_tow_021",
      "ntw3_gen_staff_148_6_0194_tow_021",
      "ntw3_gen_staff_147_2_0192_tow_021",
      "ntw3_gen_staff_145_2_0189_tow_021",
      "ntw3_gen_staff_141_5_0183_tow_021",
      "ntw3_gen_staff_144_5_0188_tow_021",
      "ntw3_gen_staff_143_2_0187_tow_021",
    ][i],
    cost: [281, 281, 159, 420, 741, 159, 159, 574, 574, 159][i],
    rosterIndex: [455, 457, 458, 459, 461, 462, 463, 464, 465, 466][i],
  }));

  it("uses the calibrated source-corps pool recovered from the ordered windows", () => {
    expect(towSourceCorpsPool(staffGens)).toEqual(["142", "143", "147", "145", "146", "140", "144", "141", "148"]);
  });

  it.each([
    ["Jul 1 23:00", new Date(2026, 6, 1, 23), ["145", "142", "141", "147"]],
    ["Jul 2 02:00", new Date(2026, 6, 2, 2), ["147", "148", "140", "146"]],
    ["Jul 2 05:00", new Date(2026, 6, 2, 5), ["147", "140", "141", "142"]],
    ["Jul 2 08:00", new Date(2026, 6, 2, 8), ["143", "144", "142", "148"]],
    ["Jul 2 11:00", new Date(2026, 6, 2, 11), ["142", "140", "146", "144"]],
    ["Jul 2 14:00", new Date(2026, 6, 2, 14), ["145", "142", "144", "147"]],
    ["Jul 2 17:00", new Date(2026, 6, 2, 17), ["146", "142", "148", "140"]],
    ["Jul 2 20:00", new Date(2026, 6, 2, 20), ["146", "145", "142", "148"]],
    ["Jul 2 23:00", new Date(2026, 6, 2, 23), ["145", "143", "147", "146"]],
  ])("matches the in-game roll at %s", (_label, at, expected) => {
    expect(rollTowSourceCorpsIds(staffGens, at as Date)).toEqual(expected);
  });
});

describe("Flandres in-game calibration (ntw3_tow_a12_x8_003)", () => {
  const staffGens = [
    staff("135", "0174"),
    staff("138", "0178"),
    staff("136", "0176"),
    staff("133", "0172"),
    staff("137", "0177"),
    staff("135", "0175"),
    staff("139", "0180"),
    staff("134", "0173"),
    staff("132", "0171"),
    staff("138", "0179"),
    staff("137", "0518"),
    staff("139", "0181"),
  ].map((c, i) => ({
    ...c,
    factionKey: "ntw3_tow_a12_x8_003",
    unitKey: [
      "ntw3_gen_staff_135_1_0174_tow_003",
      "ntw3_gen_staff_138_1_0178_tow_003",
      "ntw3_gen_staff_136_1_0176_tow_003",
      "ntw3_gen_staff_133_2_0172_tow_003",
      "ntw3_gen_staff_137_2_0177_tow_003",
      "ntw3_gen_staff_135_2_0175_tow_003",
      "ntw3_gen_staff_139_3_0180_tow_003",
      "ntw3_gen_staff_134_3_0173_tow_003",
      "ntw3_gen_staff_132_3_0171_tow_003",
      "ntw3_gen_staff_138_4_0179_tow_003",
      "ntw3_gen_staff_137_4_0518_tow_003",
      "ntw3_gen_staff_139_8_0181_tow_003",
    ][i],
    cost: [67, 67, 67, 177, 177, 177, 312, 312, 312, 467, 467, 1232][i],
    rosterIndex: [312, 314, 315, 317, 326, 332, 308, 311, 318, 323, 325, 324][i],
  }));

  it("uses the calibrated source-corps pool recovered from the ordered windows", () => {
    expect(towSourceCorpsPool(staffGens)).toEqual(["138", "135", "136", "133", "137", "132", "134", "139"]);
  });

  it.each([
    ["Jul 2 00:00", new Date(2026, 6, 2, 0), ["139", "132", "137", "138"]],
    ["Jul 2 03:00", new Date(2026, 6, 2, 3), ["139", "135", "134", "133"]],
    ["Jul 2 06:00", new Date(2026, 6, 2, 6), ["135", "138", "133", "132"]],
    ["Jul 2 09:00", new Date(2026, 6, 2, 9), ["134", "138", "137", "139"]],
    ["Jul 2 12:00", new Date(2026, 6, 2, 12), ["133", "139", "134", "132"]],
    ["Jul 2 15:00", new Date(2026, 6, 2, 15), ["136", "134", "132", "133"]],
    ["Jul 2 18:00", new Date(2026, 6, 2, 18), ["138", "133", "137", "132"]],
    ["Jul 2 21:00", new Date(2026, 6, 2, 21), ["133", "136", "139", "135"]],
  ])("matches the in-game roll at %s", (_label, at, expected) => {
    expect(rollTowSourceCorpsIds(staffGens, at as Date)).toEqual(expected);
  });
});

describe("Prusse in-game calibration (ntw3_tow_a06_x8_002)", () => {
  const staffGens = [
    staff("099", "0134"),
    staff("106", "0142"),
    staff("246", "0546"),
    staff("105", "0140"),
    staff("102", "0137"),
    staff("100", "0135"),
    staff("104", "0139"),
    staff("103", "0138"),
    staff("101", "0136"),
    staff("105", "0141"),
  ].map((c, i) => ({
    ...c,
    factionKey: "ntw3_tow_a06_x8_002",
    unitKey: [
      "ntw3_gen_staff_099_0_0134_tow_002",
      "ntw3_gen_staff_106_1_0142_tow_002",
      "ntw3_gen_staff_246_1_0546_tow_002",
      "ntw3_gen_staff_105_3_0140_tow_002",
      "ntw3_gen_staff_102_6_0137_tow_002",
      "ntw3_gen_staff_100_6_0135_tow_002",
      "ntw3_gen_staff_104_6_0139_tow_002",
      "ntw3_gen_staff_103_7_0138_tow_002",
      "ntw3_gen_staff_101_8_0136_tow_002",
      "ntw3_gen_staff_105_9_0141_tow_002",
    ][i],
    cost: [1, 46, 46, 216, 570, 570, 570, 707, 853, 1006][i],
    rosterIndex: [363, 374, 375, 358, 366, 367, 371, 361, 370, 372][i],
  }));

  it("uses the calibrated source-corps pool recovered from the ordered windows", () => {
    expect(towSourceCorpsPool(staffGens)).toEqual(["099", "106", "246", "105", "104", "102", "100", "103", "101"]);
  });

  it.each([
    ["Jul 2 00:00", new Date(2026, 6, 2, 0), ["246", "101", "102", "104"]],
    ["Jul 2 03:00", new Date(2026, 6, 2, 3), ["246", "102", "103", "099"]],
    ["Jul 2 06:00", new Date(2026, 6, 2, 6), ["106", "100", "099", "101"]],
    ["Jul 2 09:00", new Date(2026, 6, 2, 9), ["099", "102", "104", "100"]],
    ["Jul 2 12:00", new Date(2026, 6, 2, 12), ["101", "100", "105", "102"]],
    ["Jul 2 15:00", new Date(2026, 6, 2, 15), ["105", "099", "100", "246"]],
    ["Jul 2 18:00", new Date(2026, 6, 2, 18), ["104", "099", "101", "102"]],
    ["Jul 2 21:00", new Date(2026, 6, 2, 21), ["104", "105", "099", "101"]],
  ])("matches the in-game roll at %s", (_label, at, expected) => {
    expect(rollTowSourceCorpsIds(staffGens, at as Date)).toEqual(expected);
  });
});

describe("rollTowSourceCorpsIds", () => {
  it("returns all source corps unchanged when the pool has four or fewer ids", () => {
    const cards = ["081", "082", "083", "084"].map((id) => staff(id));
    expect(rollTowSourceCorpsIds(cards, new Date(2026, 5, 23, 14))).toEqual(["081", "082", "083", "084"]);
  });

  it("shuffles the source-corps pool and slices to four when more are available", () => {
    const at = new Date(2026, 5, 23, 14);
    const ids = ["081", "082", "083", "084", "085", "086"];
    const cards = ids.map((id) => staff(id));
    expect(rollTowSourceCorpsIds(cards, at)).toEqual(shuffleByDate(ids, at).slice(0, 4));
  });
});

describe("rollTowGeneralKeys", () => {
  it("returns shuffled staff keys plus up to four combat keys from the rolled source corps", () => {
    const at = new Date(2026, 5, 23, 14);
    const cards = [
      staff("081", "s1"),
      staff("082", "s2"),
      staff("083", "s3"),
      combat("081", "c1"),
      combat("082", "c2"),
      combat("083", "c3"),
      combat("084", "c4"),
      combat("082", "c5"),
      combat("081", "c6"),
    ];
    const rolled = ["081", "082"];
    const expectedStaff = shuffleByDate(cards.filter(isLegacyTowStaffGeneral), at).map((card) => card.unitKey);
    const expectedCombatPool = cards.filter((card) => isLegacyTowCombatGeneral(card) && rolled.includes(card.towSourceCorpsId!));
    const expectedCombat = shuffleByDate(expectedCombatPool, at).slice(0, 4).map((card) => card.unitKey);
    expect(rollTowGeneralKeys(cards, rolled, at)).toEqual({
      staffKeys: expectedStaff,
      combatKeys: expectedCombat,
      allKeys: [...expectedStaff, ...expectedCombat],
    });
  });

  it("does not let combat generals from unrolled source corps through", () => {
    const result = rollTowGeneralKeys([combat("081"), combat("999")], ["081"], new Date(2026, 5, 23, 14));
    expect(result.combatKeys).toHaveLength(1);
    expect(result.combatKeys[0]).toContain("_081_");
  });
});

describe("rollTowArmy", () => {
  it("keeps non-generals from rolled source corps and generals selected by the legacy general roll", () => {
    const at = new Date(2026, 5, 23, 14);
    const cards = [
      staff("081"),
      staff("082"),
      staff("083"),
      staff("084"),
      staff("085"),
      towUnit("081", "line"),
      towUnit("085", "line"),
      combat("081", "3016"),
      combat("085", "3017"),
    ];
    const sourceCorpsIds = rollTowSourceCorpsIds(cards, at);
    const result = rollTowArmy(cards, at);

    expect(result.sourceCorpsIds).toEqual(sourceCorpsIds);
    expect(result.cards.filter((card) => !card.isGeneral).every((card) => sourceCorpsIds.includes(card.towSourceCorpsId!))).toBe(true);
    expect(result.cards.filter((card) => card.isGeneral).map((card) => card.unitKey).sort()).toEqual(
      [...result.generalKeys.allKeys].sort(),
    );
  });
});

describe("findTowCorpsCombinationTime", () => {
  const cards = ["081", "082", "083", "084", "085", "086", "087"].map((id) => staff(id));

  it("reports activeNow for an exact source-corps combination in the current window", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const target = rollTowSourceCorpsIds(cards, now);
    const result = findTowCorpsCombinationTime(cards, target, now);

    expect(result.activeNow).toBe(true);
    expect(result.closestDirection).toBe("now");
    expect(result.closest!.getTime()).toBe(new Date(2026, 5, 23, 14).getTime());
    expect(new Set(result.closestSourceCorpsIds!)).toEqual(new Set(target));
  });

  it("finds nearest future and past windows for an exact combination absent now", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    let future = new Date(2026, 5, 23, 17);
    let target = rollTowSourceCorpsIds(cards, future);
    while (new Set(target).size === new Set(rollTowSourceCorpsIds(cards, now)).size
      && target.every((id) => rollTowSourceCorpsIds(cards, now).includes(id))) {
      future = new Date(future.getTime() + 3 * 60 * 60 * 1000);
      target = rollTowSourceCorpsIds(cards, future);
    }

    const result = findTowCorpsCombinationTime(cards, target, now);

    expect(result.activeNow).toBe(false);
    expect(result.next).not.toBeNull();
    expect(result.prev).not.toBeNull();
    expect(result.next!.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(result.prev!.getTime()).toBeLessThan(now.getTime());
    expect(new Set(result.next ? rollTowSourceCorpsIds(cards, result.next) : [])).toEqual(new Set(target));
    expect(new Set(result.prev ? rollTowSourceCorpsIds(cards, result.prev) : [])).toEqual(new Set(target));
  });

  it("supports contains mode for partial combinations", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const rolled = rollTowSourceCorpsIds(cards, now);
    const result = findTowCorpsCombinationTime(cards, rolled.slice(0, 2), now, "contains");

    expect(result.activeNow).toBe(true);
    expect(result.matchMode).toBe("contains");
    expect(rolled.slice(0, 2).every((id) => result.currentSourceCorpsIds.includes(id))).toBe(true);
  });

  it("returns null match times when an impossible combination is requested", () => {
    const result = findTowCorpsCombinationTime(cards, ["999"], new Date(2026, 5, 23, 14));

    expect(result.activeNow).toBe(false);
    expect(result.next).toBeNull();
    expect(result.prev).toBeNull();
    expect(result.closest).toBeNull();
    expect(result.closestSourceCorpsIds).toBeNull();
  });
});

describe("build-derived roll helpers", () => {
  const cards = [staff("081"), staff("082"), combat("081", "c1"), towUnit("081", "line"), towUnit("082", "line")];
  const index = indexRoster(makeRoster(cards, "ntw3_tow_a03_x8_032"));

  it("collects distinct source corps a build draws from, including the staff slot", () => {
    const build = buildOf([cards[3].unitKey, cards[4].unitKey], cards[0].unitKey);
    expect(towSourceCorpsIdsInBuild(build, index)).toEqual(["081", "082"]);
  });

  it("collects only combat generals from the build, ignoring staff generals", () => {
    const build = buildOf([cards[2].unitKey, cards[3].unitKey], cards[0].unitKey);
    expect(towCombatGeneralKeysInBuild(build, index)).toEqual([cards[2].unitKey]);
  });
});

describe("towCorpsCeiling", () => {
  // Six corps, one line unit each, so a build can span past the 4-corps roll.
  const ids = ["081", "082", "083", "084", "085", "086"];
  const cards = [...ids.map((id) => staff(id)), ...ids.map((id) => towUnit(id, "line"))];
  const index = indexRoster(makeRoster(cards, "ntw3_tow_a03_x8_032"));
  const lineOf = (id: string) => cards.find((c) => c.towSourceCorpsId === id && c.unitKey.includes("_line_"))!;

  it("is not over at exactly four corps and keeps them all", () => {
    const build = buildOf(["081", "082", "083", "084"].map((id) => lineOf(id).unitKey));
    const c = towCorpsCeiling(build, index);
    expect(c.count).toBe(4);
    expect(c.over).toBe(false);
    expect([...c.kept].sort()).toEqual(["081", "082", "083", "084"]);
  });

  it("flags the corps beyond the first four (first-seen order kept)", () => {
    const build = buildOf(["081", "082", "083", "084", "085"].map((id) => lineOf(id).unitKey));
    const c = towCorpsCeiling(build, index);
    expect(c.count).toBe(5);
    expect(c.over).toBe(true);
    expect(c.kept.has("085")).toBe(false);
    // The first four seen stay; only the units of the 5th corps are over.
    expect(isCardOverCorpsCeiling(lineOf("081"), c)).toBe(false);
    expect(isCardOverCorpsCeiling(lineOf("085"), c)).toBe(true);
  });

  it("tallies selected copies per corps including the staff slot", () => {
    const build = buildOf([lineOf("081").unitKey, lineOf("081").unitKey], staff("082").unitKey);
    const c = towCorpsCeiling(build, index);
    expect(c.counts.get("081")).toBe(2);
    expect(c.counts.get("082")).toBe(1);
  });

  it("marks a would-be fifth corps over only once four are already used", () => {
    const three = buildOf(["081", "082", "083"].map((id) => lineOf(id).unitKey));
    // A new corps is still fine as the fourth.
    expect(isCardOverCorpsCeiling(lineOf("084"), towCorpsCeiling(three, index))).toBe(false);
    const four = buildOf(["081", "082", "083", "084"].map((id) => lineOf(id).unitKey));
    // Now a new corps would be the fifth → over.
    expect(isCardOverCorpsCeiling(lineOf("085"), towCorpsCeiling(four, index))).toBe(true);
  });
});

describe("findTowBuildRollTime", () => {
  // Seven corps so the roll actually shuffles/slices to four.
  const cards = [
    ...["081", "082", "083", "084", "085", "086", "087"].map((id) => staff(id)),
    combat("081", "c1"),
    combat("082", "c2"),
  ];

  it("reports activeNow when the current window offers the build's corps and combat general", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const rolled = rollTowSourceCorpsIds(cards, now);
    const combatKey = rollTowGeneralKeys(cards, rolled, now).combatKeys[0];
    const corpsId = cards.find((c) => c.unitKey === combatKey)!.towSourceCorpsId!;

    const result = findTowBuildRollTime(cards, [corpsId], [combatKey], now);
    expect(result.activeNow).toBe(true);
    expect(result.closestDirection).toBe("now");
    expect(result.closestCombatGeneralKeys).toContain(combatKey);
  });

  it("requires the combat general to be offered, not merely the corps", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    // A window where corps 081 rolls but its combat general is NOT in the combat offers.
    const combatKey = cards.find((c) => c.unitKey.includes("_081_") && isLegacyTowCombatGeneral(c))!.unitKey;
    const result = findTowBuildRollTime(cards, ["081"], [combatKey], now);

    if (result.closest) {
      const rolled = rollTowSourceCorpsIds(cards, result.closest);
      expect(rolled).toContain("081");
      expect(rollTowGeneralKeys(cards, rolled, result.closest).combatKeys).toContain(combatKey);
    }
    expect(result.closest).not.toBeNull();
  });

  it("ignores combat-general constraints when the build has none", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const corpsOnly = findTowBuildRollTime(cards, ["081"], [], now);
    const combi = findTowCorpsCombinationTime(cards, ["081"], now, "contains");
    expect(corpsOnly.closest?.getTime() ?? null).toBe(combi.closest?.getTime() ?? null);
  });

  it("returns no window for an impossible corps id", () => {
    const result = findTowBuildRollTime(cards, ["999"], [], new Date(2026, 5, 23, 14));
    expect(result.closest).toBeNull();
    expect(result.closestCombatGeneralKeys).toBeNull();
  });
});
