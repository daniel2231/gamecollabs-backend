import type { TaxonomyTermInput } from "@gamecollabs/schema";

type Seed = Omit<TaxonomyTermInput, "order" | "legacyValues"> & { legacyValues?: string[] };

const t = (key: string, ko: string, en: string, parent: string | null = null, legacyValues: string[] = []): Seed => ({
  key,
  parent,
  label: { ko, en },
  legacyValues,
});

/**
 * Initial controlled vocabulary. `legacyValues` hold the free-text values found
 * in the MVP data so the migration and collectors map them to keys.
 * Order within a taxonomy follows this list.
 */
export const TAXONOMY_SEED: Seed[] = [
  // category
  t("category.in_game", "인게임 콜라보", "In-game collab", null, ["In-Game", "In Game", "Game Collab"]),
  t("category.brand_campaign", "브랜드 캠페인", "Brand campaign", null, ["Brand", "Brand Campaign", "Promotion"]),
  t("category.merchandise", "굿즈·상품", "Merchandise", null, ["Merch", "Goods", "Merchandise"]),
  t("category.offline_event", "오프라인 이벤트", "Offline event", null, ["Offline", "Event", "Offline Event", "Pop-up", "Offline Experience"]),
  t("category.media", "미디어·콘텐츠", "Media & content", null, ["Media", "Content"]),

  // partner_category
  t("partner_category.game", "게임", "Game", null, ["Game", "Games", "Video Game"]),
  t("partner_category.anime_manga", "애니메이션·만화", "Anime / Manga", null, ["Anime", "Manga", "Anime / Manga", "Anime/Manga"]),
  t("partner_category.film_tv", "영화·TV", "Film / TV", null, ["Film / TV", "Movie / TV", "Film", "Movie", "TV", "Drama"]),
  t("partner_category.music", "음악·아티스트", "Music / Artist", null, ["Music", "Music / Artist", "Artist", "K-pop", "K-Pop"]),
  t("partner_category.vtuber", "버튜버·크리에이터", "VTuber / Creator", null, ["VTuber", "VTuber / Creator", "Creator", "Streamer"]),
  t("partner_category.comics", "코믹스·그래픽노블", "Comics", null, ["Comics", "Comic", "Comic Book", "Graphic Novel"]),
  t("partner_category.webtoon_webnovel", "웹툰·웹소설", "Webtoon / Web novel", null, ["Webtoon", "Web Novel", "Webtoon / Web Novel"]),
  t("partner_category.character", "캐릭터", "Character", null, ["Character", "Character IP", "Toy / Character"]),
  t("partner_category.f_and_b", "식음료", "Food & beverage", null, ["F&B", "Food", "Food & Beverage", "Beverage", "Snack"]),
  t("partner_category.fashion", "패션·뷰티", "Fashion / Beauty", null, ["Fashion", "Beauty", "Apparel"]),
  t("partner_category.sports", "스포츠", "Sports", null, ["Sports", "Esports Team"]),
  t("partner_category.brand", "브랜드·기업", "Brand", null, ["Brand", "Company", "Retail", "Other Brand", "Tech"]),
  t("partner_category.toy", "완구·보드게임", "Toys / Tabletop", null, ["Toy", "Toys", "Tabletop", "Board Game"]),
  t("partner_category.leisure_venue", "레저·장소·문화", "Leisure / Venue / Culture", null, ["Leisure / Venue", "Culture / Heritage", "Leisure", "Venue", "Theme Park"]),
  t("partner_category.other", "기타", "Other", null, ["Other"]),

  // region
  t("region.global", "글로벌", "Global", null, ["Global", "Worldwide", "WW"]),
  t("region.asia", "아시아", "Asia", null, ["Asia"]),
  t("region.korea", "한국", "Korea", "region.asia", ["Korea", "South Korea", "KR", "대한민국"]),
  t("region.japan", "일본", "Japan", "region.asia", ["Japan", "JP"]),
  t("region.china", "중국", "China", "region.asia", ["China", "Mainland China", "CN"]),
  t("region.taiwan", "대만", "Taiwan", "region.asia", ["Taiwan", "TW"]),
  t("region.hong_kong", "홍콩", "Hong Kong", "region.asia", ["Hong Kong", "HK"]),
  t("region.southeast_asia", "동남아시아", "Southeast Asia", "region.asia", ["Southeast Asia", "SEA"]),
  t("region.north_america", "북미", "North America", null, ["North America", "NA"]),
  t("region.us", "미국", "United States", "region.north_america", ["United States", "USA", "US"]),
  t("region.ca", "캐나다", "Canada", "region.north_america", ["Canada"]),
  t("region.europe", "유럽", "Europe", null, ["Europe", "EU"]),
  t("region.uk", "영국", "United Kingdom", "region.europe", ["United Kingdom", "UK"]),
  t("region.france", "프랑스", "France", "region.europe", ["France"]),
  t("region.germany", "독일", "Germany", "region.europe", ["Germany"]),
  t("region.poland", "폴란드", "Poland", "region.europe", ["Poland"]),
  t("region.latin_america", "중남미", "Latin America", null, ["Latin America", "LATAM", "South America"]),
  t("region.oceania", "오세아니아", "Oceania", null, ["Oceania", "Australia"]),
  t("region.middle_east", "중동", "Middle East", null, ["Middle East", "MENA"]),

  // platform
  t("platform.mobile", "모바일", "Mobile", null, ["Mobile"]),
  t("platform.android", "안드로이드", "Android", "platform.mobile", ["Android"]),
  t("platform.ios", "iOS", "iOS", "platform.mobile", ["iOS", "iPhone"]),
  t("platform.pc", "PC", "PC", null, ["PC", "Steam", "Windows", "PC (Steam)", "Mac", "macOS"]),
  t("platform.console", "콘솔", "Console", null, ["Console"]),
  t("platform.playstation", "플레이스테이션", "PlayStation", "platform.console", ["PlayStation", "PS"]),
  t("platform.ps5", "PS5", "PlayStation 5", "platform.playstation", ["PlayStation 5", "PS5"]),
  t("platform.ps4", "PS4", "PlayStation 4", "platform.playstation", ["PlayStation 4", "PS4"]),
  t("platform.xbox", "Xbox", "Xbox", "platform.console", ["Xbox", "Xbox Series X|S", "Xbox One"]),
  t("platform.nintendo_switch", "닌텐도 스위치", "Nintendo Switch", "platform.console", ["Nintendo Switch", "Switch", "Nintendo Switch 2", "Switch 2"]),
  t("platform.arcade", "아케이드", "Arcade", null, ["Arcade"]),
  t("platform.web", "웹", "Web", null, ["Web", "Browser", "Web Browser", "PC Browser", "D&D Beyond", "Online Crane Game"]),
  t("platform.vr", "VR", "VR", null, ["VR"]),

  // collab_type
  t("collab_type.cosmetic_item", "스킨·코스튬", "Skin / Cosmetic", null, ["Skin", "Costume", "Cosmetic", "Cosmetic Item", "Outfit", "Character Skin"]),
  t("collab_type.playable_character", "플레이어블 캐릭터", "Playable character", null, ["Character", "Playable Character", "Collab Character"]),
  t("collab_type.in_game_reward", "인게임 보상·아이템", "In-game reward / item", null, ["In-Game Item", "In-Game Reward", "Reward", "Item", "Login Reward", "Battle Pass"]),
  t("collab_type.gacha_banner", "뽑기·배너", "Gacha / Banner", null, ["Gacha", "Banner", "Gacha Banner"]),
  t("collab_type.map_stage", "맵·스테이지", "Map / Stage", null, ["Map", "Map / Stage", "Stage"]),
  t("collab_type.game_mode", "게임 모드", "Game mode", null, ["Game Mode", "Mode", "Dungeon / Raid", "Boss Battle"]),
  t("collab_type.story_event", "스토리·이벤트 퀘스트", "Story / Event quest", null, ["Story", "Event", "Event Quest", "Story Event", "Quest / Event"]),
  t("collab_type.music", "음악·사운드", "Music / Sound", null, ["Music", "Song", "BGM", "Sound"]),
  t("collab_type.voice", "보이스", "Voice", null, ["Voice", "Voice Pack"]),
  t("collab_type.emote_sticker", "이모트·스티커", "Emote / Sticker", null, ["Emote", "Sticker", "Stamp"]),
  t("collab_type.live_event", "라이브 이벤트·대회", "Live event / Tournament", null, ["Live Event", "Live Event / Tournament", "Tournament", "Concert"]),
  t("collab_type.purchase_promotion", "구매 프로모션", "Purchase promotion", null, ["Purchase Promotion", "Campaign", "Bundle", "Code Giveaway", "Product Bundle"]),
  t("collab_type.merchandise", "굿즈·리테일", "Merchandise / Retail", null, ["Merchandise", "Merch", "Goods", "Offline Retail", "Collectible"]),
  t("collab_type.food_beverage", "식음료 메뉴·상품", "Food & beverage", null, ["F&B", "Food & Beverage", "Food", "Drink", "Collab Menu"]),
  t("collab_type.cafe_popup", "카페·팝업 스토어", "Café / Pop-up store", null, ["Cafe", "Café", "Pop-up", "Pop-up Store", "Collab Cafe"]),
  t("collab_type.offline_event", "오프라인 이벤트", "Offline event", null, ["Offline Event", "Exhibition", "Theme Park / Arcade"]),
  t("collab_type.tabletop", "보드게임·TCG", "Tabletop / TCG", null, ["Tabletop", "TCG", "Board Game"]),
  t("collab_type.advertising", "광고·영상", "Advertising / Video", null, ["Advertising", "Ad", "Commercial", "Video"]),
];
