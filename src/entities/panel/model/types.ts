export type GridSize = 6 | 8 | 10 | 12;

export type Panel = {
  id: string;
  name: string;
  gridSize: GridSize;
  cellIds: string[];
};
