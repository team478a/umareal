import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ウマリアル',
    short_name: 'ウマリアル',
    description: '馬を知る。競馬がもっとリアルになる。',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#005648',
    icons: [{ src: '/brand/umareal-icon.jpg', sizes: '1280x1280', type: 'image/jpeg' }]
  };
}
