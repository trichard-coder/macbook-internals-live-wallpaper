import profile from '../../../profiles/air.json';
import lum from '../../../assets/air/lum.webp';
import detail from '../../../assets/air/detail.webp';
import edges from '../../../assets/air/edges.webp';
import meta from '../../../assets/air/meta.json';
import maskUrl from '../../../assets/air/zones-mask.png';
import maskIndex from '../../../assets/air/zones-mask.json';
import type { Device } from '../device';
import type { Profile } from '../types';

export const AIR: Device = {
  id: 'air',
  name: 'MacBook Air',
  profile: profile as unknown as Profile,
  maps: { lum, detail, edges },
  meta,
  mask: { url: maskUrl, index: maskIndex },
  acZones: ['ports_right'],
  acRipple: 'ports_right',
};
