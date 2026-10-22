import type { EbisuApi } from '../../shared/types'
declare global {
  interface Window {
    ebisu: EbisuApi
  }
}
export {}
