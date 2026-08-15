/**
 * THE CRAFT CONTACT SHEETS — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by `npm run build-craft-sheets`, from the Centre's own "Craft thumbnail" document. Every
 * entry is one PLATE: a mosaic of six to eight photographs of a craft category, laid out on a cream
 * ground. Nine plates for the top-level categories, then one for each documented subcategory.
 *
 * ⚠ THESE ARE THE CENTRE'S OWN PICTURES AND CARRY NO THIRD-PARTY LICENCE. That is the difference
 * between this manifest and `craft-imagery.ts`, whose twenty-six photographs are openly licensed
 * from Wikimedia Commons and each of which owes an attribution rendered by ImageCredit.tsx. Nothing
 * here owes one. Do not add credit machinery to a sheet, and do not move a sheet into the other
 * manifest, whose `CraftImage` type requires licence fields a sheet has no honest values for.
 *
 * ⚠ A SHEET IS NOT A PHOTOGRAPH AND BREAKS IN TWO SPECIFIC WAYS WHEN TREATED AS ONE — as a cropped
 * full-bleed backdrop, and at thumbnail size. Both are set out in scripts/build-craft-sheets.ts.
 * Mount a sheet in a frame at its own proportion, no narrower than about 380 CSS px.
 *
 * `width` and `height` are of the STORED file, so `next/image` reserves the right box and nothing
 * shifts when the picture decodes. `blurDataUrl` is a 16px WebP, under a kilobyte, for
 * `placeholder="blur"`.
 *
 * To change a picture, replace its master in `.craft-source/` and re-run — never edit this file.
 */

export interface CraftSheet {
  /** Stable key. Appears in committed markup, so it does not change when a picture is replaced. */
  slug: string;
  /** What the plate shows, as the site would say it. The default alt text. */
  title: string;
  /** 1–9, the document's own top-level numbering. */
  categoryId: number;
  /** The category this plate belongs to, spelled out. */
  category: string;
  /** "1.2" for a subcategory plate; `null` when the plate IS the category. */
  subcategoryId: string | null;
  /** Public path, ready for `next/image`. */
  src: string;
  width: number;
  height: number;
  /** A 16px WebP data URI for `placeholder="blur"`. */
  blurDataUrl: string;
  /** Of the stored bytes. Lets a re-run tell "unchanged" from "re-encoded". */
  sha256: string;
}

export const CRAFT_SHEETS: readonly CraftSheet[] = [
  {
    slug: "textile",
    title: "Textile-based crafts",
    categoryId: 1,
    category: "Textile-based crafts",
    subcategoryId: null,
    src: "/craft/sheets/textile.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAAAwAgCdASoQAAkAA4BaJYgCdAYtLvr3YTGoAAD5CUJlfc4EI+iziprDwdYLeYy4VITc5NmW/P+BEaiXuN3nte6kmzO6D1IRHoXqzgut0rJiAXrgS83c11bNS4AAAA==",
    sha256: "b868b02956a2b364"
  },
  {
    slug: "metal",
    title: "Metal crafts",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: null,
    src: "/craft/sheets/metal.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmIAAABXRUJQVlA4IFYAAADQAQCdASoQAAkAA4BaJQBOgB6W6s0zAAD7BbhLEf0X8cD16tFKcWNUlqUxuxb+EpSG2jVYYTObQByvj2W9b6v4yaQJM68ZCFuRNPOR7SSC3JsfFVwAAA==",
    sha256: "84533baebb48c463"
  },
  {
    slug: "stone",
    title: "Stone crafts",
    categoryId: 3,
    category: "Stone crafts",
    subcategoryId: null,
    src: "/craft/sheets/stone.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAADQAQCdASoQAAkAA4BaJYgCdADhPfcUgAD7G2Vf2bLM/drrf3YvXzY21CtpM2Oe/z50BEwvlvMjiT9ia/HhtdhIAnI7oDmfmPdmzw3Xlit3wgwjDRrB3sRPwAA=",
    sha256: "9f1f93438d4ff988"
  },
  {
    slug: "wood",
    title: "Wood crafts",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: null,
    src: "/craft/sheets/wood.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAAAQAgCdASoQAAkAA4BaJQBOgCIO2ZtILnoAAP1Sy1glYHxz5RqYqs8RI9gfWI7MOfaf9BHWMfbGmm2XVSYbDb8Gna4gjnQFs3HhJ2//HuDvcn6XqrIcQAAA",
    sha256: "efff95aeb0a2aef8"
  },
  {
    slug: "leather",
    title: "Leather crafts",
    categoryId: 5,
    category: "Leather crafts",
    subcategoryId: null,
    src: "/craft/sheets/leather.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmAAAABXRUJQVlA4IFQAAADwAQCdASoQAAkAA4BaJQBOgCHf+OrYygAA9rwasgeLbUKge/iw4uhWdA6ngovsMNZAJli/W4sOcg52wOJzxmG17WIdFAgYY1yLtCixGGjWDLU2gAA=",
    sha256: "fdf2a97f8805fb1d"
  },
  {
    slug: "natural-fibre",
    title: "Natural fibre and grass crafts",
    categoryId: 6,
    category: "Natural fibre and grass crafts",
    subcategoryId: null,
    src: "/craft/sheets/natural-fibre.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADwAQCdASoQAAkAA4BaJQBOgCLWndJMtAAA/kOK/xe2kSA1JLdTE39Px3NacQAnuyYupD2IKQdX6ZGsfaYFAn6SAcnFovyTbU/Bm6PdjnDuq0iH0KKK5gAA",
    sha256: "63a6d986451dbcf2"
  },
  {
    slug: "mud",
    title: "Mud-based crafts",
    categoryId: 7,
    category: "Mud-based crafts",
    subcategoryId: null,
    src: "/craft/sheets/mud.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRl4AAABXRUJQVlA4IFIAAAAQAgCdASoQAAkAA4BaJQBOgCHPMofr9HsAAPPMTO4inww/NfvFXNwa8Yf8ux5AWYP/DLXXXOYUgsAjORhQnzKtuc0ongFv9U5uom0iEEJuwMAA",
    sha256: "89db1a280f509401"
  },
  {
    slug: "paper",
    title: "Paper crafts",
    categoryId: 8,
    category: "Paper crafts",
    subcategoryId: null,
    src: "/craft/sheets/paper.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRm4AAABXRUJQVlA4IGIAAAAQAgCdASoQAAkAA4BaJQBOgMW5u4WSEFwAAP4f7s1nZ7RJqcWrFsDu708H8qmrYUVs/cmsjXWqYMz4NQ2ATagmSvxARjTR9OuG5egryWOTFijGM+iXWK08UB1XTh/UAVhwAA==",
    sha256: "d961bcf823d7ae79"
  },
  {
    slug: "miscellaneous",
    title: "Miscellaneous crafts",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: null,
    src: "/craft/sheets/miscellaneous.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAAAQAgCdASoQAAkAA4BaJQBOgCLKJFTuzGZQAP7KfSHRZ6Qq+c/2Dh5wTQvvbbgtd8Y6QbJi0weMEv3vt6kGPznaS+gnkgR+A2ExCC4F+0INXdzrsCcugAAA",
    sha256: "a8dc6cbc9b8d648a"
  },
  {
    slug: "textile-embroidery",
    title: "Embroidery",
    categoryId: 1,
    category: "Textile-based crafts",
    subcategoryId: "1.1",
    src: "/craft/sheets/textile-embroidery.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAADQAQCdASoQAAkAA4BaJQBOgCFmTwWJYAD+12FoBfnVEqCSp01Wcb9OzWVvC8yKugh5Rx3AB5kL3z914/8KPDuH2xEc4P7vJOhNx9djB6Rm4PFxbF9aVk71fAA=",
    sha256: "db4c4908d63e9ea3"
  },
  {
    slug: "textile-block-printing",
    title: "Hand block printing",
    categoryId: 1,
    category: "Textile-based crafts",
    subcategoryId: "1.2",
    src: "/craft/sheets/textile-block-printing.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmwAAABXRUJQVlA4IGAAAAAQAgCdASoQAAkAA4BaJQBOgB8xdYiwu+gAAN5iC3GGtCzfBwf/FdgYTFNDq68nkZivYujW7Pe02wYS73wkTD/SCmNLesAdIrcgpa3HeW+OcnEp+VXS+8BgAaAc4BYAAAA=",
    sha256: "9b8ac865c606778f"
  },
  {
    slug: "textile-carpets",
    title: "Carpets, rugs and durries",
    categoryId: 1,
    category: "Textile-based crafts",
    subcategoryId: "1.3",
    src: "/craft/sheets/textile-carpets.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAAAwAgCdASoQAAkAA4BaJYwCdAYuvgeZ871XAADMoosSX80O+QmvxXW3a5p4YvHAmyteCtpgTjLNyyqZQ2REZiyb3iYUbOSKqtpKyn7vOULgCSozH3QdN2IxwAA=",
    sha256: "b1063b95f1dd0544"
  },
  {
    slug: "textile-other",
    title: "Other textile-based crafts",
    categoryId: 1,
    category: "Textile-based crafts",
    subcategoryId: "1.4",
    src: "/craft/sheets/textile-other.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAAAQAgCdASoQAAkAA4BaJQBOgCIO20wv6/8wAP3+oB/EIUiJyeAmuZhwCPg3P6YpAyKM3kiukS31oHUyHRPnD4poqgglQpuGTkS7CnLshdQfvM9wHti0LHxbk2PLoAAA",
    sha256: "0b974b2ca3e5f7d8"
  },
  {
    slug: "metal-silver",
    title: "Silver",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.1",
    src: "/craft/sheets/metal-silver.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAAAQAgCdASoQAAkAA4BaJYwCdAEKqjNukdMAAPavpo8O5P0iTog8yRZbzc+FkfMHp+/nDbY3WLGJKVL+6i0qMx59pXQZql5p5S4qLXcoItycXaFWrjA9AAAA",
    sha256: "269cd789e02dec77"
  },
  {
    slug: "metal-gold",
    title: "Gold",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.2",
    src: "/craft/sheets/metal-gold.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAADQAQCdASoQAAkAA4BaJZgCdAEOO/PuAAD+axAersDbGgMti0SxuN8PYQZvPf4E2hKzCn5zkMnud3qzElEfqLS3Acm/JjQLzXR5ugrveljBgj1fqRzTrwv0AAA=",
    sha256: "b2de66eac099d96a"
  },
  {
    slug: "metal-bronze",
    title: "Bronze",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.3",
    src: "/craft/sheets/metal-bronze.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAABQAgCdASoQAAkAA4BaJYgCdAYrxgKl54nqhAAAzg7GoKpWGShlsKe0vd3SzALTLx+HaclMOxIla1bjrVRr27rU+Q9PAV6LnhlPiKa4Ji1OMCY5NosojesqVBLkAAAA",
    sha256: "6f96c90615fc64cb"
  },
  {
    slug: "metal-brass",
    title: "Brass",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.4",
    src: "/craft/sheets/metal-brass.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADwAQCdASoQAAkAA4BaJQBOgCPysMh3OoAAzjLgLQDFMlN37qs6s6zOeeZ+fYny4D0hq19s7tEfNrWgNHxRf0wSiBFKVehDb5awblT3f6wRSGxWmFFE/AAA",
    sha256: "df1e6888e80a5239"
  },
  {
    slug: "metal-iron",
    title: "Iron",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.5",
    src: "/craft/sheets/metal-iron.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRlwAAABXRUJQVlA4IFAAAADQAQCdASoQAAkAA4BaJYwCdAEKYVnOgADOMuAVOrr9G2m6UpVF1Nr7Mxky4+4LBMfnHW6p19qZtekH5JAwKd947H0v4HV3fEkXsPqksgAAAA==",
    sha256: "2d559c9038b19331"
  },
  {
    slug: "metal-copper",
    title: "Copper",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.6",
    src: "/craft/sheets/metal-copper.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAABQAgCdASoQAAkAA4BaJQBOg0wC0tMl+h0bjIAA9FrL+vZ8ZJXLzn2E6QGESRcuZ5bdDpztIklBt//JYSIuMM2ky9XKh91hpOr/XMrBb6YByN3OenohBNKsAAA=",
    sha256: "fa87878c6b789aa5"
  },
  {
    slug: "metal-other",
    title: "Other metal crafts",
    categoryId: 2,
    category: "Metal crafts",
    subcategoryId: "2.7",
    src: "/craft/sheets/metal-other.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAAAQAgCdASoQAAkAA4BaJQBOgB7A+I5ROBwAAPZg+lFp37C4WrAvvBTGyAlPTamxBdZpL5tclTGCh9GIfjX6ljgVlakwccWKPybk3/DgPnA5osDtaH7Kfrota7zYBYAA",
    sha256: "9e865a0b4e688ba7"
  },
  {
    slug: "stone-carving",
    title: "Stone carving",
    categoryId: 3,
    category: "Stone crafts",
    subcategoryId: "3.1",
    src: "/craft/sheets/stone-carving.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmAAAABXRUJQVlA4IFQAAADwAQCdASoQAAkAA4BaJQBOgMWMyW/CW4AA/pQhK81bP4eFUvNtxNgpfOhKDBb+qWodIpGx1hHVLeD0v4BKZAB4sEzFoFSCkWBp+WHvKCvVrdZfAAA=",
    sha256: "c27d0250317aae9b"
  },
  {
    slug: "stone-inlay",
    title: "Stone inlay",
    categoryId: 3,
    category: "Stone crafts",
    subcategoryId: "3.2",
    src: "/craft/sheets/stone-inlay.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAAAwAgCdASoQAAkAA4BaJYwCdAYulv2zC2WwGAD8so9ZdJdcA1dPWsGUo/sjICkesF4yBxrCYC7kQD9aJSt1jBL0Sv/AfjutoOmgwf5yOwbxnPigOTYBYAAA",
    sha256: "d645672d69b49ee1"
  },
  {
    slug: "stone-other",
    title: "Other stone crafts",
    categoryId: 3,
    category: "Stone crafts",
    subcategoryId: "3.3",
    src: "/craft/sheets/stone-other.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmAAAABXRUJQVlA4IFQAAACwAQCdASoQAAkAA4BaJQBOgB2cU0HAAOIrZFpIVkIRBGS+HXBeP9y3Jd79zzikRdr5h47knA+5g4Psr1ozwitaM6ejFNCoJGbNKG8tq2u82D8AAAA=",
    sha256: "1e336531bf76a597"
  },
  {
    slug: "wood-artwares",
    title: "Wooden artwares",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: "4.1",
    src: "/craft/sheets/wood-artwares.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADQAQCdASoQAAkAA4BaJQBOgBul87l7+AD7ISQe2GxtQg3I/7S/Y/owsFMhR5bz85RSG7W784YfEnNcm2IEgBf79EmeOLQdeU/3CCATB1J2z2jcwJpnIAAA",
    sha256: "ea97b6ac2e801a2c"
  },
  {
    slug: "wood-carving",
    title: "Wood carving",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: "4.2",
    src: "/craft/sheets/wood-carving.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAAAQAgCdASoQAAkAA4BaJQBOgMXrtmZP9KmgAMxVdbE0LQ+L5eILLC+r4kC8AbplV7W638p7XDdCxWpp50jOHQlHFHlCraV4CbDYlf5gUrSZWP3awptwwAAA",
    sha256: "f1e2c06b55aa9801"
  },
  {
    slug: "wood-inlay",
    title: "Wood inlay and marquetry",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: "4.3",
    src: "/craft/sheets/wood-inlay.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAADwAQCdASoQAAkAA4BaJYgCdAENcl3hepAAykHNRGzWfLuCxdaREBwqkKq3utst/WbPI6JsXXvpMq6mhHJdFgy+GieplOMmQbYczgBszDGYRFDsBBQfE07KBN+AAA==",
    sha256: "bfac7cf3c16dc5ac"
  },
  {
    slug: "wood-lacquer",
    title: "Wood turning and lacquer ware",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: "4.4",
    src: "/craft/sheets/wood-lacquer.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAADQAQCdASoQAAkAA4BaJQBOgCIExwCqQADgG0HNgB4xXTk0OF4lyqnbn4+p+CeMsbzuJW7Dw+l7uqb01SXYUcujmX1q5Zc2VniIXq4kQ134djEEYaNYJpnIAAA=",
    sha256: "ba2f2da08c0f343b"
  },
  {
    slug: "wood-furniture",
    title: "Wooden furniture",
    categoryId: 4,
    category: "Wood crafts",
    subcategoryId: "4.5",
    src: "/craft/sheets/wood-furniture.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAADwAQCdASoQAAkAA4BaJQBOgMXc3E+RVsAA/KyPB7b5vOzxsxp2em/etDTiURtZHNqBIrDpt8QH3O2RXi6J+ysd3cdZ9UpnZudHrvg30bD4ttIKzC+oPi5cq9M/AAAA",
    sha256: "431f6b452fcfd823"
  },
  {
    slug: "leather-footwear",
    title: "Leather footwear",
    categoryId: 5,
    category: "Leather crafts",
    subcategoryId: "5.1",
    src: "/craft/sheets/leather-footwear.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAACQAQCdASoQAAkAA4BaJQBOgB3Lv6wA4iD/ZfOPXjHD0H+mR0DDVmPSwi6addbOKLYHiMTpoTIYOKBlWlkhMrbHdTJnzbQz2S6Xo69XDHNxw1AH9Ra5P0vVaSvwAAAA",
    sha256: "2eb0ba8455e08a51"
  },
  {
    slug: "leather-other",
    title: "Other leather articles",
    categoryId: 5,
    category: "Leather crafts",
    subcategoryId: "5.2",
    src: "/craft/sheets/leather-other.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmwAAABXRUJQVlA4IGAAAABQAgCdASoQAAkAA4BaJYgCdAYwTvqreXmJHAAA9FtE77ul1F22YOrQ4bwKZQuAUTbNE/n3ARhmIHEn6IfsEDqTZuwt6TNAQDY/JrwPeFp5y4/HkZwy+q2xBOBltp8AAAA=",
    sha256: "0a34a3839a38221b"
  },
  {
    slug: "fibre-natural",
    title: "Natural fibre",
    categoryId: 6,
    category: "Natural fibre and grass crafts",
    subcategoryId: "6.1",
    src: "/craft/sheets/fibre-natural.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAACwAQCdASoQAAkAA4BaJQBOgBq72CEAAP1PiLU13UscwFFke+iVf4QoiNfvRIM0eL8Mp3Q+s4LPrY3HmREqlFikAsG5Kgn4GIe1NyWJnCy7Q0XbVX7DwAAA",
    sha256: "bec79051dc8c79e1"
  },
  {
    slug: "fibre-cane-bamboo",
    title: "Cane and bamboo",
    categoryId: 6,
    category: "Natural fibre and grass crafts",
    subcategoryId: "6.2",
    src: "/craft/sheets/fibre-cane-bamboo.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmAAAABXRUJQVlA4IFQAAADwAQCdASoQAAkAA4BaJQBOgB6SBqVPJAAA/aQfk8sDYitS2nhUBIECuH235Pr+fABz2sjj+WTlRS7tjUq1IQictOjapcCv0GMGc0WTUHxcoTdgYAA=",
    sha256: "3d4f1485b5166a22"
  },
  {
    slug: "fibre-grass",
    title: "Grass work",
    categoryId: 6,
    category: "Natural fibre and grass crafts",
    subcategoryId: "6.3",
    src: "/craft/sheets/fibre-grass.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmIAAABXRUJQVlA4IFYAAADwAQCdASoQAAkAA4BaJYwCdAD7KIRr7AAA8m/j87kEmuI+M1N/ResW7VAPSiOrkAkwG+UHncOPRp3KDFzEpvVC1MN/JTFg8vXHiBU6d5SadUvrAAAAAA==",
    sha256: "e27d6e4b115b3140"
  },
  {
    slug: "fibre-leaf-reed",
    title: "Leaf, reed and rattan",
    categoryId: 6,
    category: "Natural fibre and grass crafts",
    subcategoryId: "6.4",
    src: "/craft/sheets/fibre-leaf-reed.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRl4AAABXRUJQVlA4IFIAAADwAQCdASoQAAkAA4BaJZACdAYukxBLJAAA/oOrndVvrcPHnP9EozhcLtnwbda1yTZlKoJ6XQQSyLdLqLmeddxwuR/ZOHTJ4mO3gpTzVlocAAAA",
    sha256: "5803720fc11bdb56"
  },
  {
    slug: "mud-terracotta",
    title: "Terracotta and pottery",
    categoryId: 7,
    category: "Mud-based crafts",
    subcategoryId: "7.1",
    src: "/craft/sheets/mud-terracotta.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADQAQCdASoQAAkAA4BaJQBOgB5Up5Fz0AD9doxUfl6Y7OdD9l3UMu6kAn7GzPo0b+nR4fne0hD5xHBrOV4lv1U90xav6C1vqZksTOFl2g+Llyr1wz9YQAAA",
    sha256: "8cb75b2865f4b90d"
  },
  {
    slug: "mud-other",
    title: "Other mud-based crafts",
    categoryId: 7,
    category: "Mud-based crafts",
    subcategoryId: "7.2",
    src: "/craft/sheets/mud-other.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADwAQCdASoQAAkAA4BaJQBOgMXS3weKJAAA+xtlEpQ211IXRQl4GpbPV8jgGIaZF8bpcba7bfmDUjyyDh4BkkrGs2RKLWxpcwL5ejhho/wucn6XqrIcQAAA",
    sha256: "9bddcce900de0b10"
  },
  {
    slug: "misc-folk-painting",
    title: "Folk painting",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.1",
    src: "/craft/sheets/misc-folk-painting.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRlwAAABXRUJQVlA4IFAAAAAQAgCdASoQAAkAA4BaJZACdAEfquHViPsAAPRiSvdQHDW3td+sAhDGOuGE9dC1xp9M6Cx0/o2tfd/PE4hmB38P+Ln038qc5vB1oQZbnTwAAA==",
    sha256: "57dc6dbe30e1670f"
  },
  {
    slug: "misc-jewellery",
    title: "Jewellery",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.2",
    src: "/craft/sheets/misc-jewellery.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAAAwAgCdASoQAAkAA4BaJQBOgMVzylHljfW5AADie336ZylRtypBeFWfOYDYKlilE1tJ2OxWw/Vhh3tQSQg+EkhkyDTbA916BY2lrmc5FL3gm+K1b6cn5pAmlWAAAA==",
    sha256: "b710ef8badab018f"
  },
  {
    slug: "misc-bone-horn-shell",
    title: "Bone, horn and shell",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.3",
    src: "/craft/sheets/misc-bone-horn-shell.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAACwAQCdASoQAAkAA4BaJQBOgCKMgPQAAPgz/atQ3NWSErDg5TYX/PHXr/eifIP3aLX8CiWZc1YXRk323rJR4ahHGeeLiha1Pgm9Oa8rtbr59yIPEXP+wCwA",
    sha256: "91eb9424b47cc673"
  },
  {
    slug: "misc-lac-wax",
    title: "Lac and wax",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.4",
    src: "/craft/sheets/misc-lac-wax.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAAAQAgCdASoQAAkAA4BaJYgCdAYv1kfGJFoAAMtLR6pnekE1pzyPSJDEmkcW0aRZv8RbirQrPZPOW2XG8UikKYoHjmMok390WvUA/r0RW+Z1CjZOf0J4i6ErSVRgAA==",
    sha256: "c8002857cda9e5f1"
  },
  {
    slug: "misc-figurines-toys",
    title: "Figurines and toys",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.5",
    src: "/craft/sheets/misc-figurines-toys.jpg",
    width: 1600,
    height: 1067,
    blurDataUrl: "data:image/webp;base64,UklGRnIAAABXRUJQVlA4IGYAAAAQAgCdASoQAAsAA4BaJZgCdAD0fzRo/AoAAPRbYYOK0evALy8QdVF0AThZ+IDznsoIf3683aKcyvffft6BrFB3sI33OpJ40Em/pSP8ro6lsrVZRwnPsunjt2zyBGGQ87HVIQ5AAAA=",
    sha256: "1752e3f0de1e8b5f"
  },
  {
    slug: "misc-musical-instruments",
    title: "Musical instruments",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.6",
    src: "/craft/sheets/misc-musical-instruments.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRl4AAABXRUJQVlA4IFIAAADwAQCdASoQAAkAA4BaJZACdAD8ZOVH6VgA9GnjABQ+eX1+zgJy66ftpKnyH30+hVEtQ9vQ4H6u06cVbRGSzO6Kk8vmJmBzvRIxcJqngP9uwAAA",
    sha256: "5fecdb352ccd9b28"
  },
  {
    slug: "misc-glass-beads",
    title: "Glass and beads",
    categoryId: 9,
    category: "Miscellaneous crafts",
    subcategoryId: "9.7",
    src: "/craft/sheets/misc-glass-beads.jpg",
    width: 1600,
    height: 893,
    blurDataUrl: "data:image/webp;base64,UklGRmQAAABXRUJQVlA4IFgAAADwAQCdASoQAAkAA4BaJYgCdADRnhe4GAAA+7Yvtlz0c87DaGWc/+W6qGEKw4HPkMeKoZIalXIRQRzhkfK+a3MDh3yUd2YJkqalYrVdpWfv2+fDrXim1AAA",
    sha256: "5b169cee5a1bc58e"
  }
];

const BY_SLUG: ReadonlyMap<string, CraftSheet> = new Map(
  CRAFT_SHEETS.map((sheet) => [sheet.slug, sheet])
);

/**
 * By slug, or null. Never throws: a slug can arrive from stored section data, and a plate can be
 * retired by a later run of the generator. Every caller must handle the null.
 */
export function craftSheet(slug: string): CraftSheet | null {
  return BY_SLUG.get(slug) ?? null;
}

/** The nine category plates, in the document's order. */
export const CRAFT_CATEGORY_SHEETS: readonly CraftSheet[] = CRAFT_SHEETS.filter(
  (sheet) => sheet.subcategoryId === null
);

/** Every slug, for a picker. */
export const CRAFT_SHEET_SLUGS: readonly string[] = CRAFT_SHEETS.map((sheet) => sheet.slug);
