"""Per-country profile data used to enrich/override identity generation
when randomuser.me has no native support for the locale.

Each profile defines:
  - name: full country name in English
  - cities: list of (city, region_or_state) tuples
  - phone: format string with `#` placeholders for digits, country code prefix included
  - postal: integer length OR a format string with `#` (digits) and `@` (uppercase letters)
  - lat / lon: approximate country centroid (string-friendly)
  - streets: list of plausible street names in local language
  - first_male / first_female / last: small but representative name pools
"""
from __future__ import annotations
import random
import secrets

PROFILES: dict[str, dict] = {
    "ar": {
        "name": "Argentina",
        "cities": [("Buenos Aires", "CABA"), ("Córdoba", "Córdoba"), ("Rosario", "Santa Fe"),
                   ("Mendoza", "Mendoza"), ("La Plata", "Buenos Aires"), ("Mar del Plata", "Buenos Aires")],
        "phone": "+54 ## ####-####",
        "postal": "@####@@@",
        "lat": "-34.6037", "lon": "-58.3816",
        "streets": ["Av. Corrientes", "Calle Florida", "Av. Santa Fe", "Av. Rivadavia", "Calle San Martín"],
        "first_male":   ["Mateo", "Santiago", "Benjamín", "Lautaro", "Joaquín", "Felipe", "Tomás", "Bautista"],
        "first_female": ["Sofía", "Valentina", "Camila", "Lucía", "Martina", "Isabella", "Catalina"],
        "last": ["González", "Rodríguez", "Gómez", "Fernández", "López", "Díaz", "Martínez", "Pérez"],
    },
    "bd": {
        "name": "Bangladesh",
        "cities": [("Dhaka", "Dhaka"), ("Chittagong", "Chattogram"), ("Khulna", "Khulna"),
                   ("Rajshahi", "Rajshahi"), ("Sylhet", "Sylhet")],
        "phone": "+880 1### ######",
        "postal": "####",
        "lat": "23.8103", "lon": "90.4125",
        "streets": ["Gulshan Avenue", "Dhanmondi Rd", "Banani Rd", "Mirpur Rd", "Uttara Sector 7"],
        "first_male":   ["Mohammad", "Abdul", "Rahim", "Karim", "Hasan", "Rakib", "Tanvir", "Imran"],
        "first_female": ["Fatima", "Ayesha", "Tahmina", "Nusrat", "Sumaiya", "Mahmuda", "Rahima"],
        "last": ["Rahman", "Ahmed", "Hossain", "Islam", "Khan", "Chowdhury", "Sarkar", "Mia"],
    },
    "be": {
        "name": "Belgium",
        "cities": [("Brussels", "Brussels-Capital"), ("Antwerp", "Flanders"), ("Ghent", "Flanders"),
                   ("Bruges", "Flanders"), ("Liège", "Wallonia"), ("Charleroi", "Wallonia")],
        "phone": "+32 # ### ## ##",
        "postal": "####",
        "lat": "50.5039", "lon": "4.4699",
        "streets": ["Rue de la Loi", "Avenue Louise", "Boulevard Anspach", "Chaussée de Charleroi"],
        "first_male":   ["Lucas", "Liam", "Noah", "Louis", "Jules", "Arthur", "Victor", "Hugo"],
        "first_female": ["Emma", "Louise", "Alice", "Léa", "Camille", "Manon", "Chloé", "Juliette"],
        "last": ["Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens"],
    },
    "cn": {
        "name": "China",
        "cities": [("Beijing", "Beijing"), ("Shanghai", "Shanghai"), ("Shenzhen", "Guangdong"),
                   ("Guangzhou", "Guangdong"), ("Chengdu", "Sichuan"), ("Hangzhou", "Zhejiang"),
                   ("Wuhan", "Hubei"), ("Xi'an", "Shaanxi")],
        "phone": "+86 1## #### ####",
        "postal": "######",
        "lat": "39.9042", "lon": "116.4074",
        "streets": ["Nanjing Road", "Wangfujing Street", "Huaihai Road", "Chang'an Avenue", "Beijing Road"],
        "first_male":   ["Wei", "Jun", "Hao", "Lei", "Bin", "Tao", "Yang", "Ming", "Bo", "Chen"],
        "first_female": ["Fang", "Min", "Jing", "Li", "Ling", "Yan", "Mei", "Xia", "Hui", "Na"],
        "last": ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou"],
    },
    "cz": {
        "name": "Czech Republic",
        "cities": [("Prague", "Prague"), ("Brno", "South Moravia"), ("Ostrava", "Moravia-Silesia"),
                   ("Plzeň", "Plzeň"), ("Liberec", "Liberec"), ("Olomouc", "Olomouc")],
        "phone": "+420 ### ### ###",
        "postal": "### ##",
        "lat": "49.8175", "lon": "15.4730",
        "streets": ["Václavské náměstí", "Wenceslas Square", "Národní třída", "Nuselská", "Karlovo náměstí"],
        "first_male":   ["Jan", "Petr", "Jakub", "Tomáš", "Lukáš", "Martin", "Michal", "Pavel"],
        "first_female": ["Eliška", "Tereza", "Anna", "Adéla", "Lucie", "Kateřina", "Klára", "Veronika"],
        "last": ["Novák", "Svoboda", "Novotný", "Dvořák", "Černý", "Procházka", "Kučera", "Veselý"],
    },
    "gr": {
        "name": "Greece",
        "cities": [("Athens", "Attica"), ("Thessaloniki", "Central Macedonia"), ("Patras", "Western Greece"),
                   ("Heraklion", "Crete"), ("Larissa", "Thessaly")],
        "phone": "+30 ### ### ####",
        "postal": "### ##",
        "lat": "37.9838", "lon": "23.7275",
        "streets": ["Ermou", "Stadiou", "Patission", "Panepistimiou", "Akademias"],
        "first_male":   ["Giorgos", "Dimitris", "Nikos", "Yiannis", "Kostas", "Vasilis", "Christos"],
        "first_female": ["Maria", "Eleni", "Katerina", "Sofia", "Ioanna", "Anna", "Vasiliki"],
        "last": ["Papadopoulos", "Papadimitriou", "Georgiou", "Ioannidis", "Konstantinou", "Nikolaou"],
    },
    "hu": {
        "name": "Hungary",
        "cities": [("Budapest", "Pest"), ("Debrecen", "Hajdú-Bihar"), ("Szeged", "Csongrád"),
                   ("Miskolc", "Borsod"), ("Pécs", "Baranya"), ("Győr", "Győr-Moson-Sopron")],
        "phone": "+36 ## ### ####",
        "postal": "####",
        "lat": "47.4979", "lon": "19.0402",
        "streets": ["Andrássy út", "Váci utca", "Rákóczi út", "Kossuth Lajos utca", "Petőfi tér"],
        "first_male":   ["Bence", "Máté", "Levente", "Ádám", "Dávid", "Péter", "László", "Gábor"],
        "first_female": ["Anna", "Sára", "Eszter", "Hanna", "Réka", "Lilla", "Kata", "Petra"],
        "last": ["Nagy", "Kovács", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár"],
    },
    "id": {
        "name": "Indonesia",
        "cities": [("Jakarta", "DKI Jakarta"), ("Surabaya", "East Java"), ("Bandung", "West Java"),
                   ("Medan", "North Sumatra"), ("Semarang", "Central Java"), ("Makassar", "South Sulawesi")],
        "phone": "+62 8## ####-####",
        "postal": "#####",
        "lat": "-6.2088", "lon": "106.8456",
        "streets": ["Jalan Sudirman", "Jalan Thamrin", "Jalan Gatot Subroto", "Jalan Asia Afrika"],
        "first_male":   ["Budi", "Agus", "Dwi", "Eko", "Andi", "Bambang", "Hendra", "Rizki"],
        "first_female": ["Siti", "Dewi", "Sari", "Indah", "Lestari", "Putri", "Ratna", "Wati"],
        "last": ["Wijaya", "Setiawan", "Pratama", "Suryanto", "Susanto", "Hidayat", "Saputra", "Kurniawan"],
    },
    "it": {
        "name": "Italy",
        "cities": [("Roma", "Lazio"), ("Milano", "Lombardia"), ("Napoli", "Campania"),
                   ("Torino", "Piemonte"), ("Firenze", "Toscana"), ("Bologna", "Emilia-Romagna"),
                   ("Genova", "Liguria"), ("Palermo", "Sicilia")],
        "phone": "+39 ### ### ####",
        "postal": "#####",
        "lat": "41.9028", "lon": "12.4964",
        "streets": ["Via del Corso", "Via Roma", "Via Garibaldi", "Via Veneto", "Corso Vittorio Emanuele"],
        "first_male":   ["Marco", "Alessandro", "Luca", "Andrea", "Matteo", "Lorenzo", "Francesco", "Giovanni"],
        "first_female": ["Giulia", "Sofia", "Aurora", "Alice", "Emma", "Giorgia", "Martina", "Chiara"],
        "last": ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci"],
    },
    "jp": {
        "name": "Japan",
        "cities": [("Tokyo", "Tokyo"), ("Osaka", "Osaka"), ("Yokohama", "Kanagawa"),
                   ("Nagoya", "Aichi"), ("Sapporo", "Hokkaido"), ("Kyoto", "Kyoto"),
                   ("Fukuoka", "Fukuoka"), ("Kobe", "Hyōgo")],
        "phone": "+81 ##-####-####",
        "postal": "###-####",
        "lat": "35.6762", "lon": "139.6503",
        "streets": ["Ginza", "Shibuya", "Roppongi", "Shinjuku", "Harajuku", "Akihabara"],
        "first_male":   ["Hiroshi", "Takeshi", "Kenji", "Yuto", "Haruto", "Sota", "Ren", "Riku"],
        "first_female": ["Sakura", "Yui", "Hina", "Aoi", "Rin", "Yuna", "Mei", "Hana"],
        "last": ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura"],
    },
    "my": {
        "name": "Malaysia",
        "cities": [("Kuala Lumpur", "Federal Territory"), ("George Town", "Penang"),
                   ("Ipoh", "Perak"), ("Johor Bahru", "Johor"), ("Shah Alam", "Selangor"),
                   ("Kuching", "Sarawak")],
        "phone": "+60 1#-### ####",
        "postal": "#####",
        "lat": "3.1390", "lon": "101.6869",
        "streets": ["Jalan Bukit Bintang", "Jalan Sultan Ismail", "Jalan Tun Razak", "Jalan Ampang"],
        "first_male":   ["Ahmad", "Muhammad", "Faisal", "Hafiz", "Razak", "Aiman", "Iskandar"],
        "first_female": ["Nurul", "Siti", "Aisyah", "Farah", "Aishah", "Hanis", "Khadijah"],
        "last": ["bin Abdullah", "bin Hassan", "bin Ahmad", "Tan", "Wong", "Lim", "Lee", "Chong"],
    },
    "ng": {
        "name": "Nigeria",
        "cities": [("Lagos", "Lagos"), ("Abuja", "FCT"), ("Kano", "Kano"),
                   ("Ibadan", "Oyo"), ("Port Harcourt", "Rivers"), ("Benin City", "Edo")],
        "phone": "+234 ### ### ####",
        "postal": "######",
        "lat": "9.0820", "lon": "8.6753",
        "streets": ["Adeola Odeku St", "Allen Avenue", "Awolowo Road", "Lagos Island Marina"],
        "first_male":   ["Chukwu", "Emeka", "Tunde", "Ade", "Olu", "Ifeanyi", "Kelechi", "Nnamdi"],
        "first_female": ["Chioma", "Ngozi", "Folake", "Amaka", "Ifeoma", "Yetunde", "Adaeze"],
        "last": ["Okafor", "Adeyemi", "Eze", "Okonkwo", "Adebayo", "Obi", "Nwankwo", "Olawale"],
    },
    "pe": {
        "name": "Peru",
        "cities": [("Lima", "Lima"), ("Arequipa", "Arequipa"), ("Trujillo", "La Libertad"),
                   ("Chiclayo", "Lambayeque"), ("Piura", "Piura"), ("Cusco", "Cusco")],
        "phone": "+51 9## ### ###",
        "postal": "#####",
        "lat": "-12.0464", "lon": "-77.0428",
        "streets": ["Av. Arequipa", "Av. Larco", "Jirón de la Unión", "Av. Javier Prado"],
        "first_male":   ["Juan", "Carlos", "José", "Luis", "Miguel", "Jorge", "Pedro"],
        "first_female": ["María", "Ana", "Rosa", "Lucía", "Sofía", "Carmen", "Isabel"],
        "last": ["Quispe", "Mamani", "Huamán", "Vargas", "Castro", "Flores", "Rojas", "García"],
    },
    "ph": {
        "name": "Philippines",
        "cities": [("Manila", "Metro Manila"), ("Quezon City", "Metro Manila"),
                   ("Davao", "Davao Region"), ("Cebu City", "Central Visayas"),
                   ("Caloocan", "Metro Manila"), ("Makati", "Metro Manila")],
        "phone": "+63 9## ### ####",
        "postal": "####",
        "lat": "14.5995", "lon": "120.9842",
        "streets": ["Ayala Avenue", "EDSA", "Roxas Boulevard", "Taft Avenue", "Quezon Avenue"],
        "first_male":   ["Juan", "Jose", "Mark", "John", "Michael", "Andrei", "Christian"],
        "first_female": ["Maria", "Angel", "Rose", "Joy", "Andrea", "Bianca", "Patricia"],
        "last": ["Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Torres", "Dela Cruz"],
    },
    "pl": {
        "name": "Poland",
        "cities": [("Warsaw", "Mazowieckie"), ("Kraków", "Małopolskie"), ("Łódź", "Łódzkie"),
                   ("Wrocław", "Dolnośląskie"), ("Poznań", "Wielkopolskie"), ("Gdańsk", "Pomorskie")],
        "phone": "+48 5## ### ###",
        "postal": "##-###",
        "lat": "52.2297", "lon": "21.0122",
        "streets": ["ul. Marszałkowska", "ul. Floriańska", "ul. Piotrkowska", "Aleje Jerozolimskie"],
        "first_male":   ["Jakub", "Kacper", "Antoni", "Filip", "Jan", "Szymon", "Michał", "Wojciech"],
        "first_female": ["Zofia", "Julia", "Hanna", "Maja", "Lena", "Alicja", "Maria", "Pola"],
        "last": ["Nowak", "Kowalski", "Wiśniewski", "Wójcik", "Kowalczyk", "Kamiński", "Lewandowski"],
    },
    "pt": {
        "name": "Portugal",
        "cities": [("Lisboa", "Lisboa"), ("Porto", "Porto"), ("Braga", "Braga"),
                   ("Coimbra", "Coimbra"), ("Faro", "Algarve")],
        "phone": "+351 9## ### ###",
        "postal": "####-###",
        "lat": "38.7223", "lon": "-9.1393",
        "streets": ["Avenida da Liberdade", "Rua Augusta", "Rua de Santa Catarina", "Avenida dos Aliados"],
        "first_male":   ["João", "Pedro", "Tiago", "André", "Rui", "Diogo", "Miguel", "Bruno"],
        "first_female": ["Maria", "Ana", "Catarina", "Beatriz", "Sofia", "Inês", "Mariana", "Joana"],
        "last": ["Silva", "Santos", "Ferreira", "Pereira", "Costa", "Oliveira", "Rodrigues", "Martins"],
    },
    "ro": {
        "name": "Romania",
        "cities": [("Bucharest", "București"), ("Cluj-Napoca", "Cluj"), ("Timișoara", "Timiș"),
                   ("Iași", "Iași"), ("Constanța", "Constanța"), ("Brașov", "Brașov")],
        "phone": "+40 7## ### ###",
        "postal": "######",
        "lat": "44.4268", "lon": "26.1025",
        "streets": ["Calea Victoriei", "Bulevardul Magheru", "Strada Lipscani", "Bulevardul Unirii"],
        "first_male":   ["Andrei", "Alexandru", "Mihai", "David", "Ștefan", "Cristian", "Vlad"],
        "first_female": ["Maria", "Andreea", "Elena", "Ioana", "Alexandra", "Ana", "Sofia"],
        "last": ["Popa", "Popescu", "Ionescu", "Pop", "Stoica", "Stan", "Munteanu", "Constantinescu"],
    },
    "ru": {
        "name": "Russia",
        "cities": [("Moscow", "Moscow"), ("Saint Petersburg", "St. Petersburg"),
                   ("Novosibirsk", "Novosibirsk Oblast"), ("Yekaterinburg", "Sverdlovsk Oblast"),
                   ("Kazan", "Tatarstan"), ("Nizhny Novgorod", "Nizhny Novgorod Oblast")],
        "phone": "+7 9## ###-##-##",
        "postal": "######",
        "lat": "55.7558", "lon": "37.6173",
        "streets": ["Tverskaya St", "Nevsky Prospekt", "Arbat St", "Leninsky Avenue"],
        "first_male":   ["Aleksandr", "Maxim", "Mikhail", "Ivan", "Artem", "Dmitri", "Andrei", "Sergei"],
        "first_female": ["Anastasia", "Maria", "Anna", "Sofia", "Alina", "Polina", "Daria", "Ekaterina"],
        "last": ["Ivanov", "Smirnov", "Kuznetsov", "Popov", "Vasiliev", "Petrov", "Sokolov", "Mikhailov"],
    },
    "sa": {
        "name": "Saudi Arabia",
        "cities": [("Riyadh", "Riyadh"), ("Jeddah", "Makkah"), ("Mecca", "Makkah"),
                   ("Medina", "Madinah"), ("Dammam", "Eastern"), ("Khobar", "Eastern")],
        "phone": "+966 5# ### ####",
        "postal": "#####",
        "lat": "24.7136", "lon": "46.6753",
        "streets": ["King Fahd Road", "Olaya Street", "Tahlia Street", "King Abdul Aziz Road"],
        "first_male":   ["Mohammed", "Abdullah", "Ahmed", "Khalid", "Saud", "Fahad", "Faisal"],
        "first_female": ["Fatima", "Aisha", "Maryam", "Noura", "Sara", "Hessa", "Latifa"],
        "last": ["Al-Saud", "Al-Otaibi", "Al-Qahtani", "Al-Harbi", "Al-Ghamdi", "Al-Shammari"],
    },
    "sg": {
        "name": "Singapore",
        "cities": [("Singapore", "Central"), ("Singapore", "East"), ("Singapore", "North"), ("Singapore", "West")],
        "phone": "+65 #### ####",
        "postal": "######",
        "lat": "1.3521", "lon": "103.8198",
        "streets": ["Orchard Road", "Marina Boulevard", "Bukit Timah Road", "Holland Road", "East Coast Road"],
        "first_male":   ["Wei Ming", "Kai Le", "Jun Hao", "Zhi Wei", "Aiden", "Ethan", "Marcus"],
        "first_female": ["Hui Fang", "Wei Ling", "Mei Ling", "Xin Yi", "Sophia", "Olivia", "Charlotte"],
        "last": ["Tan", "Lim", "Lee", "Ng", "Wong", "Chen", "Goh", "Ong"],
    },
    "za": {
        "name": "South Africa",
        "cities": [("Johannesburg", "Gauteng"), ("Cape Town", "Western Cape"),
                   ("Durban", "KwaZulu-Natal"), ("Pretoria", "Gauteng"),
                   ("Port Elizabeth", "Eastern Cape"), ("Bloemfontein", "Free State")],
        "phone": "+27 ## ### ####",
        "postal": "####",
        "lat": "-26.2041", "lon": "28.0473",
        "streets": ["Long Street", "Rivonia Road", "Sandton Drive", "Adderley Street"],
        "first_male":   ["Sipho", "Thabo", "Bongani", "Mandla", "Jacques", "Pieter", "Andries"],
        "first_female": ["Nomvula", "Thandiwe", "Lerato", "Zanele", "Anika", "Marlize", "Ingrid"],
        "last": ["Nkosi", "Dlamini", "Ndlovu", "Sithole", "Botha", "van der Merwe", "Pretorius", "du Plessis"],
    },
    "kr": {
        "name": "South Korea",
        "cities": [("Seoul", "Seoul"), ("Busan", "Busan"), ("Incheon", "Incheon"),
                   ("Daegu", "Daegu"), ("Daejeon", "Daejeon"), ("Gwangju", "Gwangju")],
        "phone": "+82 10-####-####",
        "postal": "#####",
        "lat": "37.5665", "lon": "126.9780",
        "streets": ["Gangnam-daero", "Teheran-ro", "Sejong-daero", "Hangang-daero", "Myeongdong-gil"],
        "first_male":   ["Min-jun", "Seo-jun", "Do-yun", "Si-woo", "Ji-ho", "Joon-woo", "Hyun-woo"],
        "first_female": ["Seo-yeon", "Ji-woo", "Ha-eun", "Min-seo", "Yu-na", "Soo-bin", "Ji-min"],
        "last": ["Kim", "Lee", "Park", "Choi", "Jung", "Kang", "Cho", "Yoon"],
    },
    "se": {
        "name": "Sweden",
        "cities": [("Stockholm", "Stockholm"), ("Göteborg", "Västra Götaland"),
                   ("Malmö", "Skåne"), ("Uppsala", "Uppsala"), ("Linköping", "Östergötland")],
        "phone": "+46 7# ### ## ##",
        "postal": "### ##",
        "lat": "59.3293", "lon": "18.0686",
        "streets": ["Drottninggatan", "Sveavägen", "Kungsgatan", "Götgatan", "Östermalmstorg"],
        "first_male":   ["Erik", "Lars", "Karl", "Anders", "Johan", "Per", "Mikael", "Oscar"],
        "first_female": ["Anna", "Eva", "Maria", "Karin", "Sara", "Emma", "Linnea", "Astrid"],
        "last": ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson"],
    },
    "th": {
        "name": "Thailand",
        "cities": [("Bangkok", "Bangkok"), ("Chiang Mai", "Chiang Mai"), ("Phuket", "Phuket"),
                   ("Pattaya", "Chonburi"), ("Khon Kaen", "Khon Kaen")],
        "phone": "+66 # ### ####",
        "postal": "#####",
        "lat": "13.7563", "lon": "100.5018",
        "streets": ["Sukhumvit Road", "Silom Road", "Sathorn Road", "Rama IV Road", "Phaya Thai Road"],
        "first_male":   ["Somchai", "Anan", "Niran", "Suthep", "Chai", "Boon", "Praphat"],
        "first_female": ["Siriporn", "Nattaya", "Ratana", "Suchada", "Pranee", "Wanida"],
        "last": ["Saetang", "Suwan", "Promma", "Srisuk", "Wongthong", "Phromma"],
    },
    "ug": {
        "name": "Uganda",
        "cities": [("Kampala", "Central"), ("Wakiso", "Central"), ("Mukono", "Central"),
                   ("Jinja", "Eastern"), ("Mbarara", "Western"), ("Gulu", "Northern")],
        "phone": "+256 7## ### ###",
        "postal": "#####",
        "lat": "0.3476", "lon": "32.5825",
        "streets": ["Kampala Road", "Jinja Road", "Bombo Road", "Entebbe Road"],
        "first_male":   ["Kato", "Mukasa", "Ssenga", "Wasswa", "Musoke", "Okello", "Opio"],
        "first_female": ["Nakato", "Namuli", "Nakayima", "Aciro", "Akello", "Atim"],
        "last": ["Mukasa", "Ssemakula", "Ssebagala", "Lukwago", "Kaggwa", "Tumusiime"],
    },
    "vn": {
        "name": "Vietnam",
        "cities": [("Hanoi", "Hà Nội"), ("Ho Chi Minh City", "Hồ Chí Minh"),
                   ("Da Nang", "Đà Nẵng"), ("Hai Phong", "Hải Phòng"), ("Can Tho", "Cần Thơ")],
        "phone": "+84 9## ### ###",
        "postal": "######",
        "lat": "21.0285", "lon": "105.8542",
        "streets": ["Đường Lê Lợi", "Đường Nguyễn Huệ", "Đường Trần Hưng Đạo", "Đường Hai Bà Trưng"],
        "first_male":   ["Minh", "Anh", "Hùng", "Long", "Tuấn", "Đức", "Phong", "Nam"],
        "first_female": ["Linh", "Hương", "Thảo", "Hà", "Mai", "Trang", "Phương", "Lan"],
        "last": ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Phan", "Vũ", "Đặng"],
    },
}


def _digits(n: int) -> str:
    return "".join(str(secrets.randbelow(10)) for _ in range(n))


def _letters(n: int) -> str:
    return "".join(random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(n))


def fill_format(fmt: str | int) -> str:
    """Replace '#' with digit, '@' with uppercase letter. If int — produce N digits."""
    if isinstance(fmt, int):
        return _digits(fmt)
    out = []
    for ch in fmt:
        if ch == "#":
            out.append(_digits(1))
        elif ch == "@":
            out.append(_letters(1))
        else:
            out.append(ch)
    return "".join(out)


def _feminize_surname(code: str, last: str) -> str:
    """Apply gender-aware suffix transformation to surnames in Slavic languages."""
    if code in ("pl",):
        # -ski/-cki/-dzki → -ska/-cka/-dzka
        for m, f in (("ski", "ska"), ("cki", "cka"), ("dzki", "dzka"), ("zki", "zka")):
            if last.endswith(m):
                return last[: -len(m)] + f
    if code in ("ru", "by"):
        # Cyrillic forms
        for m, f in (("ский", "ская"), ("цкий", "цкая"), ("нкий", "нкая"),
                     ("ов", "ова"), ("ев", "ева"), ("ин", "ина"), ("ын", "ына")):
            if last.endswith(m):
                return last[: -len(m)] + f
        # Latin transliterations
        for m, f in (("sky", "skaya"), ("ski", "skaya"), ("tsky", "tskaya"),
                     ("ov", "ova"), ("ev", "eva"), ("yov", "yova"),
                     ("in", "ina"), ("yn", "yna")):
            if last.endswith(m):
                return last[: -len(m)] + f
    if code == "ua":
        for m, f in (("ський", "ська"), ("цький", "цька"), ("енко", "енко")):
            if last.endswith(m):
                return last[: -len(m)] + f
        for m, f in (("ов", "ова"), ("ев", "ева"), ("ів", "іва")):
            if last.endswith(m):
                return last[: -len(m)] + f
    return last


def synth_for(code: str, gender: str | None = None) -> dict:
    """Build a synthetic identity overlay for the given country code.
    `gender` may be 'male' / 'female' to force a specific gender — used so the
    photo (from randomuser) matches the name we generate. If None, picked at
    random.
    Returns a dict of fields to OVERRIDE on top of a randomuser base.
    """
    p = PROFILES.get(code)
    if not p:
        return {}
    if gender is None:
        gender_male = random.random() < 0.5
    else:
        gender_male = gender.lower().startswith("m")
    first_pool = p["first_male"] if gender_male else p["first_female"]
    first = random.choice(first_pool)
    last = random.choice(p["last"])
    if not gender_male:
        last = _feminize_surname(code, last)
    city, region = random.choice(p["cities"])
    street = f"{random.choice(p['streets'])} {secrets.randbelow(300) + 1}"

    return {
        "full_name": f"{first} {last}",
        "gender": "Male" if gender_male else "Female",
        "phone": fill_format(p["phone"]),
        "country_full": p["name"],
        "city": city,
        "region": region,
        "street": street,
        "zip_code": fill_format(p["postal"]),
        "latitude": p["lat"],
        "longitude": p["lon"],
    }
