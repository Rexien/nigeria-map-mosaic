// Public trivia asset metadata with verified Wikimedia Commons licensing
const commons = title => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title.replaceAll(' ', '_'))}`;

export const triviaAssets = {
  hibiscus: {
    src: '/assets/trivia/10.jpg',
    title: 'Hibiscus Sabdariffa calyxes',
    author: 'Earl Benton',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: commons('Hibiscus Sabdariffa calyxes.jpg'),
    alt: 'Deep-red botanical calyx growing on a plant.',
    caption: 'The fleshy calyces are harvested and dried to make zobo. This photograph shows a fresh calyx.',
    timing: 'reveal'
  },
  suya: {
    src: '/assets/trivia/09.jpg',
    title: 'Suya in skewers',
    author: 'Halima Waziri',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: commons('Suya in skewers.jpg'),
    alt: 'Seasoned meat skewers prepared over open heat embers.',
    caption: 'Thinly sliced seasoned meat skewers prepared over open embers.',
    timing: 'reveal'
  },
  adire: {
    src: '/assets/trivia/01.jpg',
    title: 'Aso Adire',
    author: 'Olaniyan Olushola',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: commons('Aso Adire.jpg'),
    alt: 'Dark fabric with pale circular and geometric patterns.',
    caption: 'Adire uses resist-dyeing techniques to create patterns.',
    timing: 'question'
  },
  puff: {
    src: '/assets/trivia/02.jpg',
    title: 'Nigerian puff-puff',
    author: 'Afrolems; crop by Off-shell',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: commons('Nigerian-puff-puff-recipe cropped.jpg'),
    alt: 'Three rounded golden-brown fried snacks on a dark plate.',
    caption: 'Puff-puff is made from a yeast-raised dough and deep-fried.',
    timing: 'question'
  },
  nok: {
    src: '/assets/trivia/03.jpg',
    title: 'Head, Nok culture, Honolulu Museum of Art, 8349.1',
    author: 'Hiart',
    license: 'CC0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    source: commons('Head, Nok culture, terracotta, Honolulu Museum of Art, 8349.1.JPG'),
    alt: 'A terracotta head with pierced eyes and a tall, textured hairstyle.',
    caption: 'A Nok terracotta head in the Honolulu Museum of Art.',
    timing: 'question'
  },
  danfo: {
    src: '/assets/trivia/04.jpg',
    title: 'Fleet of Danfo buses in Lagos',
    author: 'Kaizenify',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: commons('Fleet of Danfo buses in Lagos.jpeg'),
    alt: 'Several small yellow minibuses on a busy Lagos street.',
    caption: 'The small yellow minibuses are known as danfo.',
    timing: 'question'
  }
};
