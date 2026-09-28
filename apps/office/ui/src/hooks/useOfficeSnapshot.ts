import { useOfficeData } from '../context/OfficeDataContext';
import type { OfficeSnapshot } from '../data/types';

export function useOfficeSnapshot(): OfficeSnapshot | null { return useOfficeData().snapshot; }
export function useOfficeLoadError(): string | null { return useOfficeData().error; }
