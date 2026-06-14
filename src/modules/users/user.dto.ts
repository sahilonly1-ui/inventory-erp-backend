export interface UserListItem {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  roles: string[];
  createdAt: Date;
}

export interface PaginatedUsers {
  items: UserListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
