// УДН 2: контуры с планов на страницах 21–23, назначения из экспликаций на страницах 14–19.
// Идентификаторы совпадают с позициями экспликации. Номера кабинетов на планах не указаны.
const uses = {
  cabinet: { label: 'Кабинет', labelKk: 'Кабинет', type: 'room' },
  staff: { label: 'Служебное помещение', labelKk: 'Қызметтік бөлме', type: 'room' },
  corridor: { label: 'Коридор', labelKk: 'Дәліз', type: 'corridor' },
  stair: { label: 'Лестница', labelKk: 'Баспалдақ', type: 'stair' },
  washroom: { label: 'Умывальная', labelKk: 'Жуыну бөлмесі', type: 'wc' },
  toilet: { label: 'Туалет', labelKk: 'Әжетхана', type: 'wc' },
  balcony: { label: 'Балкон', labelKk: 'Балкон', type: 'terrace' },
};

function rect(id, use, x, y, right, bottom) {
  return { id, ...uses[use], x, y, w: right - x, h: bottom - y, cx: (x + right) / 2, cy: (y + bottom) / 2 };
}

function poly(id, use, cx, cy, points) {
  return { id, ...uses[use], cx, cy, points };
}

// Перегородки 2-го и 3-го этажей совпадают. Назначения № 2 и № 4 различаются.
function standardUpperRooms(floor) {
  return [
    rect(1, 'stair', 368, 20, 531, 82),
    rect(2, floor === 2 ? 'staff' : 'cabinet', 368, 82, 531, 193),
    rect(3, 'cabinet', 617, 20, 762, 193),
    rect(4, floor === 2 ? 'corridor' : 'cabinet', 762, 20, 905, 193),
    rect(5, 'corridor', 905, 20, 965, 193),
    poly(6, 'corridor', 509, 271, '131,193 531,193 531,20 617,20 617,193 965,193 965,349 131,349'),
    rect(7, 'cabinet', 874, 349, 965, 574),
    poly(8, 'cabinet', 789, 431, '701,349 874,349 874,574 792,574 792,529 701,529'),
    rect(9, 'balcony', 614, 543, 777, 574),
    poly(10, 'cabinet', 614, 431, '528,349 701,349 701,529 595,529 595,574 528,574'),
    rect(11, 'corridor', 452, 349, 528, 529),
    poly(12, 'cabinet', 318, 430, '185,349 452,349 452,529 440,529 440,574 367,574 367,529 185,529'),
    rect(13, 'balcony', 193, 543, 352, 574),
    rect(14, 'cabinet', 20, 349, 185, 574),
    rect(15, 'cabinet', 20, 193, 131, 349),
    rect(16, 'cabinet', 20, 20, 185, 193),
    rect(17, 'corridor', 185, 156, 368, 193),
    rect(18, 'washroom', 185, 95, 268, 156),
    rect(19, 'washroom', 185, 20, 224, 95),
    rect(20, 'toilet', 224, 20, 268, 56),
    rect(21, 'toilet', 224, 56, 268, 95),
    rect(22, 'toilet', 268, 20, 320, 56),
    rect(23, 'toilet', 268, 56, 320, 95),
    rect(24, 'washroom', 320, 20, 368, 95),
    rect(25, 'washroom', 268, 95, 368, 156),
  ];
}

const mansardRooms = [
  rect(1, 'stair', 368, 20, 530, 82),
  rect(2, 'cabinet', 368, 82, 530, 189),
  rect(3, 'cabinet', 613, 20, 771, 189),
  rect(4, 'cabinet', 771, 20, 892, 189),
  rect(5, 'corridor', 892, 20, 958, 189),
  poly(6, 'corridor', 505, 267, '117,189 530,189 530,20 613,20 613,189 958,189 958,345 117,345'),
  poly(7, 'cabinet', 830, 433, '697,345 958,345 958,570 788,570 788,525 697,525'),
  poly(8, 'cabinet', 609, 431, '523,345 697,345 697,525 595,525 595,570 523,570'),
  rect(9, 'balcony', 611, 541, 771, 570),
  rect(10, 'corridor', 450, 345, 523, 525),
  poly(11, 'cabinet', 314, 432, '184,345 450,345 450,525 436,525 436,570 365,570 365,525 184,525'),
  rect(12, 'balcony', 179, 541, 349, 570),
  poly(13, 'cabinet', 99, 433, '20,345 184,345 184,525 165,525 165,570 20,570'),
  rect(14, 'cabinet', 20, 189, 117, 345),
  rect(15, 'cabinet', 20, 20, 183, 189),
  rect(16, 'corridor', 183, 154, 368, 189),
  rect(17, 'washroom', 183, 92, 267, 154),
  rect(18, 'washroom', 183, 20, 223, 92),
  rect(19, 'toilet', 223, 20, 267, 54),
  rect(20, 'toilet', 223, 54, 267, 92),
  rect(21, 'toilet', 267, 20, 316, 92),
  rect(22, 'washroom', 316, 20, 368, 92),
  rect(23, 'washroom', 267, 92, 368, 154),
];

function floorPlan(rooms, sourcePage) {
  return { view: [0, 0, 990, 595], rooms, wide: true, sourcePage };
}

export const udn2UpperFloors = {
  2: floorPlan(standardUpperRooms(2), 22),
  3: floorPlan(standardUpperRooms(3), 23),
  4: floorPlan(mansardRooms, 21),
};
