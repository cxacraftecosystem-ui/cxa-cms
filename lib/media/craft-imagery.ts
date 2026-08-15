/**
 * THE CRAFT IMAGERY MANIFEST — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by `npx tsx scripts/fetch-craft-imagery.ts`. Every entry describes one photograph in
 * public/craft/ and carries what its licence requires to be carried: the author, the licence, a link
 * to the licence text and a link to the file's page on Wikimedia Commons.
 *
 * ⚠ EDITING THIS FILE IS HOW A CREDIT COMES TO DISAGREE WITH THE PICTURE IT CREDITS. To change a
 * photograph, change its `query` in the script and re-run it for that slug.
 *
 * `width` and `height` are the dimensions of the STORED file, so `next/image` reserves the right
 * box and the card does not shift when the picture decodes.
 *
 * Every licence here is a free one; the script rejects anything not on its allowlist. Attribution is
 * rendered by components/site/ImageCredit.tsx, which is what actually satisfies the CC BY family.
 */

export interface CraftImage {
  /** Stable key. Appears in committed markup, so it does not change when a picture is replaced. */
  slug: string;
  /** What the photograph shows, as the site would say it. The default alt text. */
  title: string;
  /** Where the craft is from. Rendered in the caption. */
  region: string;
  /** Public path, ready for `next/image`. */
  src: string;
  width: number;
  height: number;
  author: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
  /** Of the stored bytes. Lets a re-run tell "unchanged" from "replaced upstream". */
  sha256: string;
}

export const CRAFT_IMAGES: readonly CraftImage[] = [
  {
    slug: "bandhani",
    title: "Bandhani tie-dye",
    region: "Gujarat and Rajasthan",
    src: "/craft/bandhani.jpg",
    width: 2000,
    height: 1333,
    author: "Jon Connell from Cambridge, UK",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Bandhani,_Tie_dye_dresses_drying_in_Jaipur.jpg",
    sha256: "6787d9a6f29f7ddc"
  },
  {
    slug: "bidriware",
    title: "Bidriware inlay",
    region: "Bidar, Karnataka",
    src: "/craft/bidriware.jpg",
    width: 2000,
    height: 1344,
    author: "Marsupium",
    licence: "Public domain",
    licenceUrl: null,
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Bidri-ware_tray_inlaid_with_silver_-_IMJ_84.70.132.jpg",
    sha256: "cd53be4db5d5e76e"
  },
  {
    slug: "block-print",
    title: "Hand block printing",
    region: "Bagru and Sanganer, Rajasthan",
    src: "/craft/block-print.jpg",
    width: 1333,
    height: 2000,
    author: "Anne Roberts",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Woman_doing_Block_Printing_at_Halasur_village,_Karnataka.jpg",
    sha256: "16dc73862e3048e3"
  },
  {
    slug: "blue-pottery",
    title: "Blue pottery",
    region: "Jaipur, Rajasthan",
    src: "/craft/blue-pottery.jpg",
    width: 2000,
    height: 953,
    author: "Atcelsius",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Blue_pottery_from_Jaipur.jpg",
    sha256: "d0b3bc1a71667498"
  },
  {
    slug: "brass-casting",
    title: "Brass and bell-metal work",
    region: "Moradabad, Uttar Pradesh",
    src: "/craft/brass-casting.jpg",
    width: 1920,
    height: 1080,
    author: "Ashishb04",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Brass_Handicrafts_of_Moradabad.jpg",
    sha256: "6e96ccbba7bdf816"
  },
  {
    slug: "channapatna",
    title: "Channapatna lacquered toys",
    region: "Channapatna, Karnataka",
    src: "/craft/channapatna.jpg",
    width: 2000,
    height: 1324,
    author: "Subhashish Panigrahi",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Toy_flute_from_Channapatna,_Karnataka,_India.jpg",
    sha256: "114df26e0c1d1a8b"
  },
  {
    slug: "chikankari",
    title: "Chikankari embroidery",
    region: "Lucknow, Uttar Pradesh",
    src: "/craft/chikankari.jpg",
    width: 2000,
    height: 1334,
    author: "Shyam Kumar verma clicks",
    licence: "CC0",
    licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Method_of_Block_printing_Chikankari.jpg",
    sha256: "12b85ac416d88185"
  },
  {
    slug: "dhokra",
    title: "Dhokra lost-wax casting",
    region: "Bastar, Chhattisgarh",
    src: "/craft/dhokra.jpg",
    width: 2000,
    height: 1120,
    author: "Sumita Roy Dutta",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Dokra_from_tribes_of_Bastar_DSCN1172_02.jpg",
    sha256: "85253aae6336344f"
  },
  {
    slug: "handloom",
    title: "Handloom weaving",
    region: "Kanchipuram, Tamil Nadu",
    src: "/craft/handloom.jpg",
    width: 2000,
    height: 1500,
    author: "McKay Savage",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Complicated_hand-loom_for_silk_weaving,_Kanchipuram,_Tamil_Nadu.jpg",
    sha256: "22215cab506aff09"
  },
  {
    slug: "jaali",
    title: "Stone jaali screen",
    region: "Rajasthan and Gujarat",
    src: "/craft/jaali.jpg",
    width: 2000,
    height: 1333,
    author: "Amarjitchaudhary",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Sidi_saiyad_jali_ahmedabad.jpg",
    sha256: "07dcd3cd8644ca67"
  },
  {
    slug: "kalamkari",
    title: "Kalamkari hand-painting",
    region: "Srikalahasti, Andhra Pradesh",
    src: "/craft/kalamkari.jpg",
    width: 2000,
    height: 1408,
    author: "Unknown",
    licence: "CC0",
    licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Kalamkari_Rumal_MET_DT11759.jpg",
    sha256: "f8e78dcc02e63589"
  },
  {
    slug: "kantha",
    title: "Kantha running stitch",
    region: "Bengal",
    src: "/craft/kantha.jpg",
    width: 2000,
    height: 1311,
    author: "Hiart",
    licence: "CC0",
    licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Kantha_(bed_cover)_from_Bengal,_Honolulu_Museum_of_Art,_3983.1.JPG",
    sha256: "e04b7d80bee43344"
  },
  {
    slug: "khurja-pottery",
    title: "Khurja glazed pottery",
    region: "Khurja, Uttar Pradesh",
    src: "/craft/khurja-pottery.jpg",
    width: 2000,
    height: 1125,
    author: "Sankoswal",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Khurja_Pottery.jpg",
    sha256: "c48a5cd01734b575"
  },
  {
    slug: "kolam",
    title: "Kolam floor drawing",
    region: "Tamil Nadu",
    src: "/craft/kolam.jpg",
    width: 2000,
    height: 1127,
    author: "Jon Robson",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Diwali_decorations_flower_with_diya_in_the_middle_India_November_2012.jpg",
    sha256: "5bfebe9511eb790c"
  },
  {
    slug: "madhubani",
    title: "Madhubani painting",
    region: "Mithila, Bihar",
    src: "/craft/madhubani.jpg",
    width: 2000,
    height: 1332,
    author: "Raj Gopal Singh Verma राजगोपाल सिंह वर्मा",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Madhubani_paintings_or_Milithila_Painting_-IMG_0028.jpg",
    sha256: "fb0198416f96c2a0"
  },
  {
    slug: "papier-mache",
    title: "Papier-mâché pen box",
    region: "Kashmir",
    src: "/craft/papier-mache.jpg",
    width: 1920,
    height: 768,
    author: "Unknown",
    licence: "Public domain",
    licenceUrl: null,
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Pen_Box_(qalamdan)_LACMA_M.89.160a-b.jpg",
    sha256: "17040a886cca559b"
  },
  {
    slug: "pashmina",
    title: "Pashmina hand-weaving",
    region: "Srinagar, Kashmir",
    src: "/craft/pashmina.jpg",
    width: 2000,
    height: 1500,
    author: "AG",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Pashmina_weaving_in_Srinagar.jpg",
    sha256: "f999d3c62bcd3716"
  },
  {
    slug: "patola",
    title: "Patola double ikat",
    region: "Patan, Gujarat",
    src: "/craft/patola.jpg",
    width: 1500,
    height: 2000,
    author: "Jainamishra",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Antique_Patan_Patola_Double_Ikat_Trade_Textile_courtesy_Wovensouls_Collection,_Singapore.jpg",
    sha256: "01229b72038998f0"
  },
  {
    slug: "pattachitra",
    title: "Pattachitra scroll painting",
    region: "Raghurajpur, Odisha",
    src: "/craft/pattachitra.jpg",
    width: 1181,
    height: 2000,
    author: "Patrick.zip",
    licence: "CC0",
    licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Pattachitra_of_Jagannath.jpg",
    sha256: "3d790a9db1d41fc2"
  },
  {
    slug: "phulkari",
    title: "Phulkari darning stitch",
    region: "Punjab",
    src: "/craft/phulkari.jpg",
    width: 2000,
    height: 1296,
    author: "Hiart",
    licence: "CC0",
    licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Bridal_shawl_(phulkari)_from_Punjab,_khadi_(hand-spun,_hand-woven_cotton),_silk,_plain_weave,_embroidery,_Honolulu_Museum_of_Art.JPG",
    sha256: "51b6a4b67b644e12"
  },
  {
    slug: "pichwai",
    title: "Pichwai temple hanging",
    region: "Nathdwara, Rajasthan",
    src: "/craft/pichwai.jpg",
    width: 1984,
    height: 2000,
    author: "Unknown",
    licence: "Public domain",
    licenceUrl: null,
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Temple_hanging_(pechhavai)_-_Google_Art_Project.jpg",
    sha256: "ea0c3e98b590c643"
  },
  {
    slug: "terracotta",
    title: "Terracotta temple work",
    region: "Bishnupur, West Bengal",
    src: "/craft/terracotta.jpg",
    width: 2000,
    height: 1333,
    author: "SuvadipSanyal",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Jor_group_of_temples_in_Bishnupur_50.jpg",
    sha256: "66003ff93de00f9e"
  },
  {
    slug: "thanjavur",
    title: "Thanjavur gilded painting",
    region: "Thanjavur, Tamil Nadu",
    src: "/craft/thanjavur.jpg",
    width: 1500,
    height: 2000,
    author: "Iramuthusamy",
    licence: "CC BY-SA 3.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Tanjore_Painting_Vinyaka.jpg",
    sha256: "250e0adf7689f91d"
  },
  {
    slug: "warli",
    title: "Warli wall painting",
    region: "Palghar, Maharashtra",
    src: "/craft/warli.jpg",
    width: 2000,
    height: 1125,
    author: "Parvathisri",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Warli_art_in_a_home.jpg",
    sha256: "d582ac0e8d5b3467"
  },
  {
    slug: "wood-carving",
    title: "Wood carving",
    region: "Odisha",
    src: "/craft/wood-carving.jpg",
    width: 2000,
    height: 1333,
    author: "Kritzolina",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Woodcarving_in_the_Odisha_Crafts_Museum_02.jpg",
    sha256: "c657c30c45bbd7d6"
  },
  {
    slug: "zardozi",
    title: "Zardozi metal embroidery",
    region: "Hyderabad, Telangana",
    src: "/craft/zardozi.jpg",
    width: 1500,
    height: 2000,
    author: "vijay chennupati from Sydney, Australia",
    licence: "CC BY 2.0",
    licenceUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Zari_zardozi_in_Hyderabad,_India.jpeg",
    sha256: "c78c80b465e97ced"
  }
];

/** By slug, or null. Never throws: a slug can arrive from stored section data. */
export function craftImage(slug: string): CraftImage | null {
  return CRAFT_IMAGES.find((image) => image.slug === slug) ?? null;
}

/** Every slug, for a picker. */
export const CRAFT_IMAGE_SLUGS: readonly string[] = CRAFT_IMAGES.map((image) => image.slug);
