import profile from '../../../profiles/pro.json';
import lum from '../../../assets/pro/lum.webp';
import detail from '../../../assets/pro/detail.webp';
import edges from '../../../assets/pro/edges.webp';
import meta from '../../../assets/pro/meta.json';
import maskUrl from '../../../assets/pro/zones-mask.png';
import maskIndex from '../../../assets/pro/zones-mask.json';
import partsUrl from '../../../assets/pro/zones-parts.png';
import partsIndex from '../../../assets/pro/zones-parts.json';
import type { Device } from '../device';
import type { Profile } from '../types';

export const PRO: Device = {
  id: 'pro',
  name: 'MacBook Pro',
  profile: profile as unknown as Profile,
  maps: { lum, detail, edges },
  meta,
  mask: { url: maskUrl, index: maskIndex },
  parts: { url: partsUrl, index: partsIndex },
  acZones: ['magsafe', 'ports_left', 'ports_right'],
  acRipple: 'magsafe',
};
